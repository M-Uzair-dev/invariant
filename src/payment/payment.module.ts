import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { TokenModule } from '../tokens/token.module';
import { PaymentExpiryWorker } from './payment-expiry.worker';

@Module({
  imports: [TokenModule],
  controllers: [PaymentController],
  providers: [PaymentService, PaymentExpiryWorker],
})
export class PaymentModule {}
