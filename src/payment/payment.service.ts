import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/createPayment.dto';
import { PrismaService } from '../utils/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PaymentStatus } from '../generated/prisma/enums';
import { Prisma } from '../generated/prisma/client';

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

  async approvePayment(userId: string, paymentId: string) {
    const userAccount = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        accountId: true,
      },
    });
    if (!userAccount)
      throw new UnauthorizedException(
        'User account not found, please login again.',
      );

    const paymentStore = await this.prisma.payment.findUnique({
      where: {
        id: paymentId,
      },
      select: {
        id: true,
        amountCents: true,
        store: {
          select: {
            id: true,
            accountId: true,
          },
        },
      },
    });
    if (!paymentStore)
      throw new NotFoundException('Payment not found, please try again.');
    await this.prisma.$transaction(async (tx) => {
      const PaymentRes = await tx.payment.updateMany({
        where: {
          id: paymentId,
          expiresAt: {
            gt: new Date(),
          },
          status: 'PENDING',
        },
        data: {
          status: 'SUCCESS',
          userId,
        },
      });
      await this.checkFailedPayment(PaymentRes.count, paymentId, tx);
      const userAccountRes = await tx.account.updateMany({
        where: {
          id: userAccount.accountId,
          balanceCents: {
            gte: paymentStore.amountCents,
          },
        },
        data: {
          balanceCents: {
            decrement: paymentStore.amountCents,
          },
        },
      });
      if (userAccountRes.count === 0)
        throw new UnprocessableEntityException('Insufficient Funds.');

      await tx.transfer.create({
        data: {
          paymentId: paymentStore.id,
          amountCents: paymentStore.amountCents,
          fromAccountId: userAccount.accountId,
          toAccountId: paymentStore.store.accountId,
          type: 'PAYMENT',
        },
      });
      await tx.webhookEvent.create({
        data: {
          paymentId: paymentId,
        },
      });
      await tx.account.update({
        where: {
          id: paymentStore.store.accountId,
        },
        data: {
          balanceCents: {
            increment: paymentStore.amountCents,
          },
        },
      });
    });
    return {
      success: true,
      message: 'Payment Success.',
    };
  }
  private async checkFailedPayment(
    count: number,
    paymentId: string,
    tx: Prisma.TransactionClient,
  ) {
    if (count > 0) return;
    const payment = await tx.payment.findUnique({
      where: {
        id: paymentId,
      },
    });
    if (!payment)
      throw new NotFoundException('Requested payment has been deleted.');
    if (payment.status === 'SUCCESS')
      throw new ConflictException('Payment already paid.');
    if (payment.status === 'EXPIRED' || payment.expiresAt <= new Date()) {
      throw new ConflictException('Payment has been expired.');
    }

    throw new InternalServerErrorException(
      'Something went wrong, please try again.',
    );
  }
  async getPayment(paymentId: string, storeId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: {
        id: paymentId,
        storeId,
      },
      select: {
        id: true,
        amountCents: true,
        expiresAt: true,
        createdAt: true,
        orderId: true,
        status: true,
        returnUrl: true,
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return {
      ...payment,
      amountCents: Number(payment.amountCents),
    };
  }
}
