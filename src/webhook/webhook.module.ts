import { Module } from '@nestjs/common';
import { WebhookWorker } from './webhook.worker';

@Module({
  providers: [WebhookWorker],
})
export class WebhookModule {}
