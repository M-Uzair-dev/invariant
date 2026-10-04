import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaClient } from '../src/generated/prisma/client';

export async function ensureSystemAccount(
  prisma: PrismaClient,
): Promise<string> {
  try {
    const newAccount = await prisma.account.create({
      data: {
        type: 'SYSTEM',
      },
      select: {
        id: true,
      },
    });
    return newAccount.id;
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError && e.code == 'P2002') {
      const existing = await prisma.account.findFirst({
        where: {
          type: 'SYSTEM',
        },
        select: {
          id: true,
        },
      });
      if (!existing) throw e;
      return existing.id;
    }
    throw e;
  }
}
