import { Injectable } from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';

@Injectable()
export class WebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async getFailedWebhooks(
    storeId: string,
    take: number = 20,
    cursorId?: string,
  ) {
    const webhooks = await this.prisma.webhookEvent.findMany({
      where: {
        status: 'FAILED',
        payment: {
          storeId,
        },
      },
      take: take + 1,
      ...(cursorId && {
        cursor: {
          id: cursorId,
        },
      }),
      select: {
        id: true,
        lastError: true,
        lastResponseStatus: true,
        lastTried: true,
        attempts: true,
        createdAt: true,
        paymentId: true,
        payment: {
          select: {
            orderId: true,
            status: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let nextCursor: string | null = null;
    if (webhooks.length > take) {
      nextCursor = webhooks.pop()!.id;
    }
    return {
      webhooks,
      nextCursor,
    };
  }
}
