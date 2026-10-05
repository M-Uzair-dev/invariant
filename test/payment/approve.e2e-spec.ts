import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  assertLedgerInvariants,
  createStore,
  createTestApp,
  createUser,
  resetState,
  TestStore,
} from '../helpers';

describe('Approve payment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: TestStore;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    store = await createStore(app, {
      webhookUrl: 'https://shop.example.com/hooks',
    });
    ({ token } = await createUser(app));
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- helpers ----------

  let orderSeq = 0;
  const createPayment = async (amountCents = 2500) => {
    orderSeq += 1;
    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${store.secretKey}`)
      .set('Idempotency-Key', `pay-key-${orderSeq}`)
      .send({
        amountCents,
        orderId: `order-${orderSeq}`,
        returnUrl: 'https://shop.example.com/return',
      })
      .expect(201);
    return res.body.id as string;
  };

  let topupSeq = 0;
  const fund = async (amountCents: number, userToken = token) => {
    topupSeq += 1;
    await request(app.getHttpServer())
      .post('/account/topup')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `topup-${topupSeq}`)
      .send({ amountCents })
      .expect(201);
  };

  const approve = (paymentId: string, auth: string | null = token) => {
    let req = request(app.getHttpServer()).post(
      `/payments/${paymentId}/approve`,
    );
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    return req.send();
  };

  const accountOf = async (email: string) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, account: true },
      })
    ).account;

  const balances = async (email = 'ali@test.com') => {
    const user = await accountOf(email);
    const storeRow = await prisma.store.findUniqueOrThrow({
      where: { id: store.storeId },
      select: { account: true },
    });
    return { user: user.balanceCents, store: storeRow.account.balanceCents };
  };

  // Invariants 3, 4 and 7 (the outbox half): every SUCCESS payment has exactly
  // one PAYMENT transfer for its amount and exactly one outbox row; nothing
  // that isn't SUCCESS has either. Call alongside assertLedgerInvariants.
  const assertPaymentInvariants = async () => {
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
         OR (p.status = 'PENDING' AND (
               EXISTS (SELECT 1 FROM "Transfer" t WHERE t."paymentId" = p.id)
            OR EXISTS (SELECT 1 FROM "WebhookEvent" w WHERE w."paymentId" = p.id)))`;
    expect(bad).toEqual([]);

    const [{ negative }] = await prisma.$queryRaw<{ negative: number }[]>`
      SELECT COUNT(*)::int AS negative FROM "Account"
      WHERE type <> 'SYSTEM' AND "balanceCents" < 0`;
    expect(negative).toBe(0);
  };

  const assertAllInvariants = async () => {
    await assertLedgerInvariants(app);
    await assertPaymentInvariants();
  };

  // ---------- tests ----------

  describe('happy path', () => {
    it('moves the money, records one transfer and one outbox row, and binds the user', async () => {
      await fund(5000);
      const paymentId = await createPayment(2500);

      await approve(paymentId).expect(201);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      const userAccount = await accountOf('ali@test.com');
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: 'ali@test.com' },
      });
      expect(payment.status).toBe('SUCCESS');
      expect(payment.userId).toBe(user.id);

      expect(await balances()).toEqual({ user: 2500n, store: 2500n });

      const transfers = await prisma.transfer.findMany({
        where: { paymentId },
        include: { from: true, to: true },
      });
      expect(transfers).toHaveLength(1);
      expect(transfers[0].type).toBe('PAYMENT');
      expect(transfers[0].amountCents).toBe(2500n);
      expect(transfers[0].fromAccountId).toBe(userAccount.id);
      expect(transfers[0].to.type).toBe('STORE');

      const events = await prisma.webhookEvent.findMany({
        where: { paymentId },
      });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('PENDING');

      await assertAllInvariants();
    });

    it('allows spending the exact balance down to 0', async () => {
      await fund(2500);
      const paymentId = await createPayment(2500);

      await approve(paymentId).expect(201);

      expect(await balances()).toEqual({ user: 0n, store: 2500n });
      await assertAllInvariants();
    });

    it('handles several payments from one user to one store in sequence', async () => {
      await fund(10000);
      const a = await createPayment(1000);
      const b = await createPayment(2000);
      const c = await createPayment(3000);

      await approve(a).expect(201);
      await approve(b).expect(201);
      await approve(c).expect(201);

      expect(await balances()).toEqual({ user: 4000n, store: 6000n });
      expect(await prisma.transfer.count({ where: { type: 'PAYMENT' } })).toBe(
        3,
      );
      await assertAllInvariants();
    });
  });

  describe('insufficient funds', () => {
    it('returns 422, leaves the payment PENDING and moves nothing', async () => {
      await fund(1000);
      const paymentId = await createPayment(2500);

      await approve(paymentId).expect(422);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('PENDING');
      expect(payment.userId).toBeNull();
      expect(await balances()).toEqual({ user: 1000n, store: 0n });
      expect(await prisma.transfer.count({ where: { paymentId } })).toBe(0);
      expect(await prisma.webhookEvent.count({ where: { paymentId } })).toBe(0);
      await assertAllInvariants();
    });

    it('returns 422 for a user with no money at all', async () => {
      const paymentId = await createPayment(1);

      await approve(paymentId).expect(422);

      expect(await balances()).toEqual({ user: 0n, store: 0n });
      await assertAllInvariants();
    });

    it('lets the user top up and retry before expiry', async () => {
      await fund(1000);
      const paymentId = await createPayment(2500);
      await approve(paymentId).expect(422);

      await fund(1500);
      await approve(paymentId).expect(201);

      expect(await balances()).toEqual({ user: 0n, store: 2500n });
      await assertAllInvariants();
    });
  });

  describe('payments that cannot be approved', () => {
    it('rejects a payment past expiresAt that the worker has not expired yet (409)', async () => {
      await fund(5000);
      const paymentId = await createPayment(2500);
      await prisma.payment.update({
        where: { id: paymentId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await approve(paymentId).expect(409);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('PENDING');
      expect(await balances()).toEqual({ user: 5000n, store: 0n });
      await assertAllInvariants();
    });

    it('rejects a payment with status EXPIRED (409)', async () => {
      await fund(5000);
      const paymentId = await createPayment(2500);
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
      });

      await approve(paymentId).expect(409);

      expect(await balances()).toEqual({ user: 5000n, store: 0n });
      await assertAllInvariants();
    });

    it('rejects re-approving an already paid payment without charging again (409)', async () => {
      await fund(5000);
      const paymentId = await createPayment(2500);
      await approve(paymentId).expect(201);

      const res = await approve(paymentId).expect(409);

      expect(res.body.message).toMatch(/already paid/i);
      expect(await balances()).toEqual({ user: 2500n, store: 2500n });
      await assertAllInvariants();
    });

    it('says "already paid", not "expired", for a paid payment whose expiresAt has passed', async () => {
      await fund(5000);
      const paymentId = await createPayment(2500);
      await approve(paymentId).expect(201);
      await prisma.payment.update({
        where: { id: paymentId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await approve(paymentId).expect(409);

      expect(res.body.message).toMatch(/already paid/i);
      await assertAllInvariants();
    });

    it("rejects a second user approving a payment someone else already paid (409), and doesn't charge them", async () => {
      await fund(5000);
      const { token: sara } = await createUser(app, 'sara@test.com');
      await fund(5000, sara);
      const paymentId = await createPayment(2500);
      await approve(paymentId).expect(201);

      await approve(paymentId, sara).expect(409);

      expect((await accountOf('sara@test.com')).balanceCents).toBe(5000n);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { user: true },
      });
      expect(payment.user?.email).toBe('ali@test.com');
      await assertAllInvariants();
    });

    it('returns 404 for a well-formed id that does not exist', async () => {
      await approve(randomUUID()).expect(404);
    });

    it('returns 400 for a malformed id (ParseUUIDPipe) before touching the DB', async () => {
      await approve('not-a-uuid').expect(400);
    });
  });

  describe('auth', () => {
    it('rejects a request without a session (401)', async () => {
      const paymentId = await createPayment();
      await approve(paymentId, null).expect(401);
    });

    it('rejects a store session (403)', async () => {
      const paymentId = await createPayment();
      await approve(paymentId, store.token).expect(403);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('PENDING');
    });

    it('rejects a store API secret key used as a session token (401)', async () => {
      const paymentId = await createPayment();
      await approve(paymentId, store.secretKey).expect(401);
    });

    it('returns 401 when the session outlives its user row', async () => {
      const paymentId = await createPayment();
      await prisma.user.delete({ where: { email: 'ali@test.com' } });

      await approve(paymentId).expect(401);
    });
  });

  describe('concurrency', () => {
    it('invariant 3: 10 parallel approvals of one payment charge exactly once', async () => {
      await fund(100000);
      const paymentId = await createPayment(2500);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => approve(paymentId)),
      );
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([201, ...Array(9).fill(409)]);
      expect(await balances()).toEqual({ user: 97500n, store: 2500n });
      expect(await prisma.transfer.count({ where: { paymentId } })).toBe(1);
      expect(await prisma.webhookEvent.count({ where: { paymentId } })).toBe(1);
      await assertAllInvariants();
    });

    it('invariant 3: 10 different users racing for one payment, only the winner is charged', async () => {
      const tokens: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { token: t } = await createUser(app, `racer${i}@test.com`);
        await fund(5000, t);
        tokens.push(t);
      }
      const paymentId = await createPayment(2500);

      const results = await Promise.all(
        tokens.map((t) => approve(paymentId, t)),
      );
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([201, ...Array(9).fill(409)]);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { user: { include: { account: true } } },
      });
      expect(payment.status).toBe('SUCCESS');
      expect(payment.user?.account.balanceCents).toBe(2500n);

      const charged = await prisma.account.count({
        where: {
          balanceCents: { lt: 5000 },
          user: { email: { startsWith: 'racer' } },
        },
      });
      expect(charged).toBe(1);
      await assertAllInvariants();
    });

    it('invariant 5: parallel approvals of different payments never overdraw the user', async () => {
      await fund(1000);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await createPayment(300));

      const results = await Promise.all(ids.map((id) => approve(id)));
      const statuses = results.map((r) => r.status).sort();

      // 1000 / 300 → exactly 3 fit; the other 2 are insufficient funds.
      expect(statuses).toEqual([201, 201, 201, 422, 422]);
      expect(await balances()).toEqual({ user: 100n, store: 900n });
      expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(
        3,
      );
      expect(
        await prisma.payment.count({
          where: { status: 'PENDING', userId: null },
        }),
      ).toBe(2);
      await assertAllInvariants();
    });

    it('a top-up racing an approval: both land and nothing drifts', async () => {
      await fund(3000);
      const paymentId = await createPayment(2500);

      const [approval] = await Promise.all([approve(paymentId), fund(1000)]);

      expect(approval.status).toBe(201);
      expect(await balances()).toEqual({ user: 1500n, store: 2500n });
      await assertAllInvariants();
    });
  });
});
