import { Module } from '@nestjs/common';
import { WebhookWorker } from './webhook.worker';
import { FailedWebhookWorker } from './failedWebhooks.worker';
import { MailModule } from '../mail/mailer.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [MailModule],
  controllers: [WebhookController],
  providers: [WebhookWorker, FailedWebhookWorker, WebhookService],
})
export class WebhookModule {}
