import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  async replayWebhook(id: string, storeId: string) {
    const updated = await this.prisma.webhookEvent.updateMany({
      where: {
        id: id,
        status: 'FAILED',
        payment: {
          storeId,
        },
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        lastResponseStatus: null,
        lastTried: null,
        nextAttemptAt: new Date(),
      },
    });
    if (updated.count === 1) {
      return {
        id: id,
        status: 'PENDING',
      };
    }

    const newWebhook = await this.prisma.webhookEvent.findUnique({
      where: {
        id,
        payment: {
          storeId,
        },
      },
    });
    if (!newWebhook) throw new NotFoundException('Webhook now found.');
    if (newWebhook.status === 'DELIVERED') {
      throw new ConflictException('Webhook has already been delivered.');
    }
    if (newWebhook.status === 'PENDING') {
      throw new ConflictException('Webhook is already pending.');
    }
    throw new ConflictException(
      'Webhook could not be replayed, please try again.',
    );
  }
}
