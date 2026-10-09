import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../utils/guards/apiKey.guard';
import { CurrentStore } from '../utils/decorators/store.param';
import { WebhookService } from './webhook.service';
import { ListFailedWebhooksDto } from './dto/listFailedWebhooks.dto';

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @UseGuards(ApiKeyGuard)
  @Get('failed')
  getFailedWebhooks(
    @CurrentStore('storeId') storeId: string,
    @Query() query: ListFailedWebhooksDto,
  ) {
    return this.webhookService.getFailedWebhooks(
      storeId,
      query.take,
      query.cursor,
    );
  }
}
