import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { expect } from 'vitest';
import { ensureSystemAccount } from '../prisma/ensureSystemAccount';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/utils/prisma/prisma.service';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export async function resetState(app: INestApplication) {
  // Safety check: refuse to wipe anything that isn't the test database
  if (!process.env.DATABASE_URL?.includes('invariant_test')) {
    throw new Error('Refusing to reset: DATABASE_URL is not the test database');
  }
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE "WebhookEvent", "Transfer", "Payment", "User", "Store", "Account" CASCADE',
  );
  await ensureSystemAccount(prisma);
  await app.get<Redis>('REDIS_CLIENT').flushdb();
}

export interface TestStore {
  storeId: string;
  token: string;
  secretKey: string;
  signingSecret: string;
}

// Signs up a store through the real endpoint. Pass webhookUrl to set it
// directly in the DB: PUT /store/webhook resolves DNS, which tests shouldn't need.
export async function createStore(
  app: INestApplication,
  opts: { email?: string; webhookUrl?: string | null } = {},
): Promise<TestStore> {
  const email = opts.email ?? 'shop@test.com';
  const res = await request(app.getHttpServer())
    .post('/auth/signup-store')
    .send({ name: 'Shop', email, password: 'secret123' })
    .expect(201);

  const prisma = app.get(PrismaService);
  const store = await prisma.store.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  if (opts.webhookUrl !== undefined) {
    await prisma.store.update({
      where: { id: store.id },
      data: { webhookUrl: opts.webhookUrl },
    });
  }
  return { storeId: store.id, ...res.body };
}

export async function createUser(
  app: INestApplication,
  email = 'ali@test.com',
): Promise<{ token: string }> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup-user')
    .send({ name: 'Ali', email, password: 'secret123' })
    .expect(201);
  return res.body;
}

// Invariants 1 and 2: balances sum to zero (SYSTEM included, so money is never
// created or destroyed), and every cached balance equals incoming minus outgoing
// transfers. Call this at the end of any test that moves money.
export async function assertLedgerInvariants(app: INestApplication) {
  const prisma = app.get(PrismaService);

  const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM("balanceCents"), 0)::bigint AS total FROM "Account"`;
  expect(total).toBe(0n);

  const drift = await prisma.$queryRaw<unknown[]>`
    SELECT a.id, a."balanceCents"::text AS cached,
           (COALESCE(i.s, 0) - COALESCE(o.s, 0))::text AS ledger
    FROM "Account" a
    LEFT JOIN (SELECT "toAccountId" AS id, SUM("amountCents") AS s
               FROM "Transfer" GROUP BY "toAccountId") i ON i.id = a.id
    LEFT JOIN (SELECT "fromAccountId" AS id, SUM("amountCents") AS s
               FROM "Transfer" GROUP BY "fromAccountId") o ON o.id = a.id
    WHERE a."balanceCents" <> COALESCE(i.s, 0) - COALESCE(o.s, 0)`;
  expect(drift).toEqual([]);
}

// Invariants 4 and 7, across every status:
// - SUCCESS: exactly one PAYMENT transfer for its amount, exactly one outbox row
// - EXPIRED: no transfer, exactly one outbox row
// - PENDING: no transfer, no outbox row
export async function assertPaymentInvariants(app: INestApplication) {
  const prisma = app.get(PrismaService);
  const bad = await prisma.$queryRaw<unknown[]>`
    SELECT p.id, p.status,
           (SELECT COUNT(*)::int FROM "Transfer" t WHERE t."paymentId" = p.id) AS transfers,
           (SELECT COUNT(*)::int FROM "WebhookEvent" w WHERE w."paymentId" = p.id) AS events
    FROM "Payment" p
    WHERE (p.status = 'SUCCESS' AND (
             (SELECT COUNT(*) FROM "Transfer" t
               WHERE t."paymentId" = p.id AND t."amountCents" = p."amountCents"
                 AND t.type = 'PAYMENT') <> 1
          OR (SELECT COUNT(*) FROM "WebhookEvent" w WHERE w."paymentId" = p.id) <> 1))
       OR (p.status = 'EXPIRED' AND (
             EXISTS (SELECT 1 FROM "Transfer" t WHERE t."paymentId" = p.id)
          OR (SELECT COUNT(*) FROM "WebhookEvent" w WHERE w."paymentId" = p.id) <> 1))
       OR (p.status = 'PENDING' AND (
             EXISTS (SELECT 1 FROM "Transfer" t WHERE t."paymentId" = p.id)
          OR EXISTS (SELECT 1 FROM "WebhookEvent" w WHERE w."paymentId" = p.id)))`;
  expect(bad).toEqual([]);
}
