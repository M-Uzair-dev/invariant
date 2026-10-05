import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { TokenModule } from '../tokens/token.module';

@Module({
  imports: [TokenModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
