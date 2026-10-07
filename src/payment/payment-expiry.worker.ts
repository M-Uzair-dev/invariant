import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';
import { Interval } from '@nestjs/schedule';

@Injectable()
export class PaymentExpiryWorker {
  private readonly logger = new Logger(PaymentExpiryWorker.name);
  constructor(private readonly prisma: PrismaService) {}

  private normalizeIds(ids: { id: string }[]): string[] {
    return ids.map((entry) => entry.id);
  }
  private running = false;

  @Interval(600000) // 10 minutes
  async expireDuePayments() {
    if (this.running) return;
    this.running = true;
    try {
      let processing = true;
      let total = 0;
      while (processing) {
        await this.prisma.$transaction(async (tx) => {
          const ids = await tx.payment.findMany({
            where: {
              status: 'PENDING',
              expiresAt: {
                lte: new Date(),
              },
            },
            select: {
              id: true,
            },
            take: 100,
          });
          const normalized = this.normalizeIds(ids);
          const updatedIds = await tx.payment.updateManyAndReturn({
            where: {
              id: {
                in: normalized,
              },
              status: 'PENDING',
            },
            data: {
              status: 'EXPIRED',
            },
            select: {
              id: true,
            },
          });
          const updatedNormalizedIds = this.normalizeIds(updatedIds);
          total += updatedNormalizedIds.length;

          if (normalized.length < 100) processing = false;
          await tx.webhookEvent.createMany({
            data: updatedNormalizedIds.map((id) => {
              return { paymentId: id };
            }),
          });
        });
      }
      if (total > 0) this.logger.log('Expired ' + total + ' Payments.');
    } catch (e) {
      this.logger.error(
        'Expiry tick failed',
        e instanceof Error ? e.stack : String(e),
      );
    } finally {
      this.running = false;
    }
  }
}
