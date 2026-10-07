import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../utils/guards/apiKey.guard';
import { CurrentStore } from '../utils/decorators/store.param';
import type { AuthStore } from '../utils/decorators/store.param';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/createPayment.dto';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser } from '../utils/decorators/user.param';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}
  @UseGuards(ApiKeyGuard)
  @Post()
  createPayment(
    @CurrentStore() store: AuthStore,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePaymentDto,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255)
      throw new BadRequestException(
        'Idempotency-Key header is required (max 255 characters).',
      );
    return this.paymentService.createPayment(
      store.storeId,
      store.webhookUrl,
      idempotencyKey,
      dto,
    );
  }

  @Auth('USER')
  @Post(':id/approve')
  approvePayment(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    return this.paymentService.approvePayment(userId, paymentId);
  }

  @UseGuards(ApiKeyGuard)
  @Get(':id')
  getPayment(
    @CurrentStore('storeId') id: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    return this.paymentService.getPayment(paymentId, id);
  }
}
