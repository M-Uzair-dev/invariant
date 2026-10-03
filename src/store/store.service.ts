import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';
import { webhookUrlProblem } from '../utils/net/webhook-url';

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService) {}

  // The URL can be changed but never removed: once a store can create
  // payments, its events must always have somewhere to go.
  async setWebhookUrl(storeId: string, url: string) {
    const problem = await webhookUrlProblem(url);
    if (problem) throw new BadRequestException(problem);

    const store = await this.prisma.store.update({
      where: { id: storeId },
      data: { webhookUrl: url },
      select: { webhookUrl: true },
    });
    return { webhookUrl: store.webhookUrl };
  }
}
