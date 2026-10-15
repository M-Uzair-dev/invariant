import { Injectable } from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';

export interface BalanceDrift {
  accountId: string;
  cached: string;
  ledger: string;
}

export interface PaymentProblem {
  paymentId: string;
  status: string;
  amountCents: string;
  transferId: string | null;
  transferAmountCents: string | null;
  eventId: string | null;
}

export interface DirectionProblem {
  transferId: string;
  type: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: string;
}

export interface ReconciliationReport {
  ok: boolean;
  checkedAt: Date;
  conservationTotal: string;
  balanceDrift: BalanceDrift[];
  paymentProblems: PaymentProblem[];
  directionProblems: DirectionProblem[];
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  run(): Promise<ReconciliationReport> {
    return this.prisma.$transaction(
      async (tx) => {
        const checkedAt = new Date();

        const sum = await tx.account.aggregate({
          _sum: { balanceCents: true },
        });
        const conservationTotal = sum._sum.balanceCents ?? 0n;

        const balanceDrift = await tx.$queryRaw<BalanceDrift[]>`
          SELECT a.id AS "accountId",
                 a."balanceCents"::text AS cached,
                 (COALESCE(i.total_in, 0) - COALESCE(o.total_out, 0))::bigint::text AS ledger
          FROM "Account" a
          LEFT JOIN (SELECT "toAccountId" AS id, SUM("amountCents") AS total_in
                     FROM "Transfer" GROUP BY "toAccountId") i ON i.id = a.id
          LEFT JOIN (SELECT "fromAccountId" AS id, SUM("amountCents") AS total_out
                     FROM "Transfer" GROUP BY "fromAccountId") o ON o.id = a.id
          WHERE a."balanceCents" <> COALESCE(i.total_in, 0) - COALESCE(o.total_out, 0)
          ORDER BY a.id`;

        const paymentProblems = await tx.$queryRaw<PaymentProblem[]>`
          SELECT p.id AS "paymentId",
                 p.status::text AS status,
                 p."amountCents"::text AS "amountCents",
                 t.id AS "transferId",
                 t."amountCents"::text AS "transferAmountCents",
                 w.id AS "eventId"
          FROM "Payment" p
          LEFT JOIN "Transfer" t ON t."paymentId" = p.id
          LEFT JOIN "WebhookEvent" w ON w."paymentId" = p.id
          WHERE (p.status = 'SUCCESS'
                  AND (t.id IS NULL OR t."amountCents" <> p."amountCents" OR w.id IS NULL))
             OR (p.status = 'EXPIRED' AND (t.id IS NOT NULL OR w.id IS NULL))
             OR (p.status = 'PENDING' AND (t.id IS NOT NULL OR w.id IS NOT NULL))
          ORDER BY p.id`;

        const directionProblems = await tx.$queryRaw<DirectionProblem[]>`
          SELECT t.id AS "transferId",
                 t.type::text AS type,
                 t."fromAccountId",
                 t."toAccountId",
                 t."amountCents"::text AS "amountCents"
          FROM "Transfer" t
          JOIN "Account" fa ON fa.id = t."fromAccountId"
          JOIN "Account" ta ON ta.id = t."toAccountId"
          LEFT JOIN "Payment" p ON p.id = t."paymentId"
          LEFT JOIN "User" u ON u.id = p."userId"
          LEFT JOIN "Store" s ON s.id = p."storeId"
          WHERE (t.type = 'PAYMENT'
                  AND (t."fromAccountId" IS DISTINCT FROM u."accountId"
                       OR t."toAccountId" IS DISTINCT FROM s."accountId"))
             OR (t.type = 'TOPUP' AND (fa.type <> 'SYSTEM' OR ta.type <> 'USER'))
          ORDER BY t.id`;

        return {
          ok:
            conservationTotal === 0n &&
            balanceDrift.length === 0 &&
            paymentProblems.length === 0 &&
            directionProblems.length === 0,
          checkedAt,
          conservationTotal: conservationTotal.toString(),
          balanceDrift,
          paymentProblems,
          directionProblems,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 60_000 },
    );
  }
}
