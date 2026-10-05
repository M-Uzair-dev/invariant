import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';
import { ensureSystemAccount } from '../../prisma/ensureSystemAccount';
import { createHash } from 'crypto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { UserType } from '../types/userRolesType';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async topupAccount(
    userId: string,
    amountCents: number,
    idempotencyKey: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        accountId: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User account not found!');
    }

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId,
          amountCents: Number(amountCents),
          idempotencyKey,
        }),
      )
      .digest('hex');

    let systemAccountId: string;

    const systemAccount = await this.prisma.account.findFirst({
      where: {
        type: 'SYSTEM',
      },
      select: {
        id: true,
      },
    });
    if (!systemAccount) {
      systemAccountId = await ensureSystemAccount(this.prisma);
    } else {
      systemAccountId = systemAccount.id;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        let transfer;

        transfer = await tx.transfer.create({
          data: {
            amountCents,
            type: 'TOPUP',
            fromAccountId: systemAccountId,
            toAccountId: user.accountId,
            requestHash,
            topupIdempotencyKey: idempotencyKey,
          },
        });

        await tx.account.update({
          where: {
            id: user.accountId,
          },
          data: {
            balanceCents: {
              increment: amountCents,
            },
          },
        });
        await tx.account.update({
          where: {
            id: systemAccountId,
          },
          data: {
            balanceCents: {
              decrement: amountCents,
            },
          },
        });

        return {
          transferId: transfer.id,
          amountCents: Number(transfer.amountCents),
        };
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError) {
        if (e.code == 'P2002') {
          const existingTransfer = await this.prisma.transfer.findUnique({
            where: {
              toAccountId_topupIdempotencyKey: {
                toAccountId: user.accountId,
                topupIdempotencyKey: idempotencyKey,
              },
            },
          });

          if (existingTransfer) {
            if (existingTransfer.requestHash !== requestHash) {
              throw new UnprocessableEntityException(
                'Idempotency key already in use.',
              );
            }
            return {
              transferId: existingTransfer.id,
              amountCents: Number(existingTransfer.amountCents),
            };
          } else throw e;
        } else throw e;
      } else throw e;
    }
  }

  async getAccountBalance(userId: string, userType: UserType) {
    const owner =
      userType === 'USER'
        ? await this.prisma.user.findUnique({
            where: { id: userId },
            select: { account: { select: { balanceCents: true } } },
          })
        : await this.prisma.store.findUnique({
            where: { id: userId },
            select: { account: { select: { balanceCents: true } } },
          });
    if (!owner)
      throw new UnauthorizedException('Invalid Id, please login again.');
    return { balanceCents: Number(owner.account.balanceCents) };
  }
}
