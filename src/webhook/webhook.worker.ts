import { createHmac } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../utils/prisma/prisma.service';
import { PaymentStatus } from '../generated/prisma/enums';
import { webhookUrlProblem } from '../utils/net/webhook-url';

type WebhookEventType = 'payment.succeeded' | 'payment.expired';

type WebhookPayload = {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: {
    paymentId: string;
    orderId: string;
    status: PaymentStatus;
    amountCents: number;
  };
};

class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly responseStatus: number | null = null,
  ) {
    super(message);
  }
}

const BATCH_SIZE = 100;
const LEASE_MS = 60000; // 1 minute
const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_HTTP_TIMEOUT_MS = 10000; // timeout + write-back must stay well under LEASE_MS
const BASE_DELAY_MS = 5000; // 5 seconds
const MAX_DELAY_MS = 3600000; // 1 hour: ~10 fast retries, then hourly
const MAX_ATTEMPTS = 34; // ~85 min of fast retries + 24 hourly ones ≈ 1 day

@Injectable()
export class WebhookWorker implements OnModuleInit {
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly intervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly allowLoopback: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.intervalMs = Number(
      config.get('WEBHOOK_WORKER_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS,
    );
    this.httpTimeoutMs = Number(
      config.get('WEBHOOK_HTTP_TIMEOUT_MS') ?? DEFAULT_HTTP_TIMEOUT_MS,
    );
    this.allowLoopback = config.get('WEBHOOK_ALLOW_LOOPBACK') === 'true';
  }

  private running = false;

  onModuleInit() {
    if (this.intervalMs <= 0) {
      this.logger.warn('Webhook delivery timer is disabled');
      return;
    }
    this.schedulerRegistry.addInterval(
      'webhook-delivery',
      setInterval(() => void this.sendRequests(), this.intervalMs),
    );
  }

  async sendRequests() {
    if (this.running) return;
    this.running = true;
    try {
      let processing = true;
      let delivered = 0;
      let failed = 0;
      let deadLettered = 0;
      while (processing) {
        const lockedUntil = new Date(Date.now() + LEASE_MS);
        const dueEvents = await this.prisma.webhookEvent.findMany({
          where: {
            nextAttemptAt: {
              lte: new Date(),
            },
            status: 'PENDING',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
          },
          select: {
            id: true,
          },
          take: BATCH_SIZE,
        });
        if (dueEvents.length < BATCH_SIZE) processing = false;
        if (dueEvents.length === 0) break;

        const webhooks = await this.prisma.webhookEvent.updateManyAndReturn({
          where: {
            id: {
              in: dueEvents.map((wb) => wb.id),
            },
            nextAttemptAt: {
              lte: new Date(),
            },
            status: 'PENDING',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
          },
          data: {
            lockedUntil: lockedUntil,
          },
          select: {
            id: true,
            attempts: true,
            createdAt: true,
            payment: {
              select: {
                status: true,
                id: true,
                orderId: true,
                amountCents: true,
                storeId: true,
                store: {
                  select: {
                    webhookUrl: true,
                    webhookSigningSecret: true,
                  },
                },
              },
            },
          },
        });

        const results = await Promise.allSettled(
          webhooks.map(async (webhook) => {
            const type = this.eventType(webhook.payment.status);
            if (!type) {
              this.logger.error(
                `Webhook event ${webhook.id} exists for PENDING payment ${webhook.payment.id}`,
              );
              throw new WebhookDeliveryError('Payment is still PENDING');
            }
            return this.sendHttpRequest(
              webhook.payment.store.webhookUrl,
              webhook.payment.store.webhookSigningSecret,
              {
                id: webhook.id,
                type,
                createdAt: webhook.createdAt.toISOString(),
                data: {
                  paymentId: webhook.payment.id,
                  orderId: webhook.payment.orderId,
                  status: webhook.payment.status,
                  amountCents: Number(webhook.payment.amountCents),
                },
              },
            );
          }),
        );

        const now = new Date();
        const successes: {
          id: string;
          storeId: string;
          responseStatus: number;
        }[] = [];

        const failures: {
          id: string;
          storeId: string;
          attempts: number;
          error: string;
          responseStatus: number | null;
        }[] = [];

        results.forEach((result, i) => {
          if (result.status === 'fulfilled')
            successes.push({
              id: webhooks[i].id,
              storeId: webhooks[i].payment.storeId,
              responseStatus: result.value,
            });
          else
            failures.push({
              id: webhooks[i].id,
              storeId: webhooks[i].payment.storeId,
              attempts: webhooks[i].attempts,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
              responseStatus:
                result.reason instanceof WebhookDeliveryError
                  ? result.reason.responseStatus
                  : null,
            });
        });

        const deliveredStoreIds = new Set<string>();
        for (const success of successes) {
          const deliveredRes = await this.prisma.webhookEvent.updateMany({
            where: {
              id: success.id,
              lockedUntil: lockedUntil,
            },
            data: {
              status: 'DELIVERED',
              deliveredAt: now,
              lockedUntil: null,
              lastTried: now,
              lastError: null,
              lastResponseStatus: success.responseStatus,
            },
          });
          if (deliveredRes.count === 1) {
            delivered++;
            deliveredStoreIds.add(success.storeId);
          }
        }

        if (deliveredStoreIds.size > 0)
          await this.prisma.store.updateMany({
            where: {
              id: {
                in: [...deliveredStoreIds],
              },
              webhookAlertSentAt: {
                not: null,
              },
            },
            data: {
              webhookAlertSentAt: null,
            },
          });

        for (const failure of failures) {
          const attempts = failure.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            const dead = await this.prisma.$transaction(async (tx) => {
              const deadRes = await tx.webhookEvent.updateMany({
                where: {
                  id: failure.id,
                  lockedUntil: lockedUntil,
                },
                data: {
                  status: 'FAILED',
                  lockedUntil: null,
                  attempts: attempts,
                  lastTried: now,
                  lastError: failure.error,
                  lastResponseStatus: failure.responseStatus,
                },
              });
              if (deadRes.count === 0) return false;
              await tx.store.updateMany({
                where: {
                  id: failure.storeId,
                  webhookAlertSentAt: null,
                  webhookAlertOwedAt: null,
                },
                data: {
                  webhookAlertOwedAt: now,
                },
              });
              return true;
            });
            if (dead) {
              deadLettered++;
              this.logger.warn(
                `Webhook event ${failure.id} dead-lettered after ${attempts} attempts: ${failure.error}`,
              );
            }
            continue;
          }

          const failedRes = await this.prisma.webhookEvent.updateMany({
            where: {
              id: failure.id,
              lockedUntil: lockedUntil,
            },
            data: {
              lockedUntil: null,
              lastTried: now,
              lastError: failure.error,
              lastResponseStatus: failure.responseStatus,
              nextAttemptAt: new Date(
                now.getTime() + this.retryDelay(failure.attempts),
              ),
              attempts: attempts,
            },
          });
          failed += failedRes.count;
        }
      }
      if (delivered > 0 || failed > 0 || deadLettered > 0)
        this.logger.log(
          `Webhooks: ${delivered} delivered, ${failed} failed, ${deadLettered} dead-lettered this tick.`,
        );
    } catch (e) {
      this.logger.error(
        'Webhook tick failed',
        e instanceof Error ? e.stack : String(e),
      );
    } finally {
      this.running = false;
    }
  }

  private retryDelay(attempts: number): number {
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
    return Math.round(delay * (0.8 + Math.random() * 0.4));
  }

  private eventType(status: PaymentStatus): WebhookEventType | null {
    if (status === 'SUCCESS') return 'payment.succeeded';
    if (status === 'EXPIRED') return 'payment.expired';
    return null;
  }

  private async sendHttpRequest(
    webhookUrl: string | null,
    signingSecret: string,
    payload: WebhookPayload,
  ): Promise<number> {
    if (!webhookUrl) throw new WebhookDeliveryError('Store has no webhook URL');

    if (!(this.allowLoopback && new URL(webhookUrl).hostname === '127.0.0.1')) {
      const problem = await webhookUrlProblem(webhookUrl);
      if (problem) throw new WebhookDeliveryError(problem);
    }

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', signingSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Invariant-Event-Id': payload.id,
          'Invariant-Signature': `t=${timestamp},v1=${signature}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
    } catch (e) {
      // fetch hides the real reason (ECONNREFUSED, ENOTFOUND...) in e.cause
      const { code, message } =
        (e as { cause?: { code?: string; message?: string } })?.cause ?? {};
      const cause = code ?? message;
      throw new WebhookDeliveryError(
        (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
          (cause ? ` (${cause})` : ''),
      );
    }
    await res.body?.cancel();

    if (res.status < 200 || res.status >= 300)
      throw new WebhookDeliveryError(
        `Store responded with ${res.status}`,
        res.status,
      );
    return res.status;
  }
}
