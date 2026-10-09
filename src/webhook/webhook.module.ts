import { Module } from '@nestjs/common';
import { WebhookWorker } from './webhook.worker';
import { FailedWebhookWorker } from './failedWebhooks.worker';
import { MailModule } from '../mail/mailer.module';

@Module({
  imports: [MailModule],
  providers: [WebhookWorker, FailedWebhookWorker],
})
export class WebhookModule {}
