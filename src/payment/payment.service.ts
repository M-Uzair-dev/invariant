import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/createPayment.dto';
import { PrismaService } from '../utils/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PaymentStatus } from '../generated/prisma/enums';

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  async createPayment(
    storeId: string,
    webhookUrl: string | null,
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ) {
    if (!webhookUrl)
      throw new BadRequestException(
        'Webhook Url not set, payment could not be created.',
      );

    let payment: {
      id: string;
      status: PaymentStatus;
      amountCents: bigint;
      orderId: string;
      expiresAt: Date;
    };
    const request = {
      storeId,
      idempotencyKey,
      amountCents: dto.amountCents,
      orderId: dto.orderId,
      returnUrl: dto.returnUrl,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    try {
      payment = await this.prisma.payment.create({
        data: {
          amountCents: dto.amountCents,
          idempotencyKey,
          orderId: dto.orderId,
          returnUrl: dto.returnUrl,
          expiresAt: new Date(
            Date.now() +
              Number(this.config.getOrThrow('PAYMENTS_EXPIRY_SECONDS')) * 1000,
          ),
          storeId,
          requestHash,
          status: 'PENDING',
        },
        select: {
          id: true,
          status: true,
          amountCents: true,
          orderId: true,
          expiresAt: true,
        },
      });
    } catch (e: any) {
      if (e instanceof PrismaClientKnownRequestError) {
        if (e.code == 'P2002') {
          const newPayment = await this.prisma.payment.findUnique({
            where: {
              idempotencyKey_storeId: {
                idempotencyKey,
                storeId,
              },
            },
            select: {
              id: true,
              status: true,
              amountCents: true,
              orderId: true,
              expiresAt: true,
              requestHash: true,
            },
          });
          if (!newPayment) {
            throw new ConflictException(
              'An active payment already exists for this orderId.',
            );
          }
          if (requestHash !== newPayment.requestHash) {
            throw new UnprocessableEntityException(
              'Idempotency key already in use with a different request.',
            );
          }
          const { requestHash: _, ...rest } = newPayment;
          payment = rest;
        } else throw e;
      } else throw e;
    }

    return {
      ...payment,
      amountCents: Number(payment.amountCents),
      checkoutUrl:
        this.config.getOrThrow('PAYMENT_PAGE_URL') + `/${payment.id}`,
    };
  }
}
