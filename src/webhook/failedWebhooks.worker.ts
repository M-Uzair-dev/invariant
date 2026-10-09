import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../utils/prisma/prisma.service';
import { MAILER } from '../mail/mailer';
import type { Mailer } from '../mail/mailer';

const BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 600000; // 10 minutes

@Injectable()
export class FailedWebhookWorker implements OnModuleInit {
  private readonly logger = new Logger(FailedWebhookWorker.name);
  private readonly intervalMs: number;
  private isWorking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.intervalMs = Number(
      config.get('WEBHOOK_ALERT_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS,
    );
  }

  onModuleInit() {
    if (this.intervalMs <= 0) {
      this.logger.warn('Webhook alert timer is disabled');
      return;
    }
    this.schedulerRegistry.addInterval(
      'webhook-alert',
      setInterval(() => void this.sendFailureEmails(), this.intervalMs),
    );
  }

  async sendFailureEmails() {
    if (this.isWorking) return;
    this.isWorking = true;
    let running = true;
    let lastStoreId: string | null = null;
    try {
      while (running) {
        const stores: { id: string; email: string }[] =
          await this.prisma.store.findMany({
            where: {
              webhookAlertOwedAt: {
                not: null,
              },
              ...(lastStoreId && { id: { gt: lastStoreId } }),
            },
            select: {
              id: true,
              email: true,
            },
            orderBy: { id: 'asc' },
            take: BATCH_SIZE,
          });
        if (stores.length < BATCH_SIZE) {
          running = false;
        }
        if (stores.length == 0) break;
        lastStoreId = stores[stores.length - 1].id;
        await Promise.allSettled(
          stores.map(async (store) => {
            try {
              await this.mailer.sendEmail(
                store.email,
                'Your webhooks are not working, fix that shi',
                "That's why you dont vibe code critical endpoints.",
              );
              try {
                await this.prisma.store.updateMany({
                  where: {
                    id: store.id,
                    webhookAlertOwedAt: {
                      not: null,
                    },
                  },
                  data: {
                    webhookAlertOwedAt: null,
                    webhookAlertSentAt: new Date(),
                  },
                });
              } catch (e) {
                this.logger.error(
                  `Failed to mark the alert as sent for ${store.email}`,
                  e,
                );
              }
            } catch (e) {
              this.logger.error(
                `Failed to send the webhook failure email to ${store.email}`,
                e,
              );
            }
          }),
        );
      }
    } catch (e) {
      this.logger.error('Webhook alert tick failed', e);
    } finally {
      this.isWorking = false;
    }
  }
}
