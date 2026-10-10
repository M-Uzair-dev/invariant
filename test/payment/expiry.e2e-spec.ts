import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentExpiryWorker } from '../../src/payment/payment-expiry.worker';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  assertLedgerInvariants,
  assertPaymentInvariants,
  createStore,
  createTestApp,
  createUser,
  resetState,
  TestStore,
  sessionCookie,
} from '../helpers';

describe('Payment expiry worker (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: PaymentExpiryWorker;
  let store: TestStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    worker = app.get(PaymentExpiryWorker);
  });

  beforeEach(async () => {
    await resetState(app);
    store = await createStore(app, {
      webhookUrl: 'https://shop.example.com/hooks',
    });
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

  const makeDue = (paymentId: string) =>
    prisma.payment.update({
      where: { id: paymentId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

  // Inserts `count` overdue PENDING payments directly: faster than HTTP for big backlogs.
  const insertDuePayments = async (count: number) => {
    const past = new Date(Date.now() - 60_000);
    await prisma.payment.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        status: 'PENDING' as const,
        amountCents: 100n,
        idempotencyKey: `bulk-${i}`,
        requestHash: `bulk-hash-${i}`,
        returnUrl: 'https://shop.example.com/return',
        orderId: `bulk-order-${i}`,
        storeId: store.storeId,
        expiresAt: past,
      })),
    });
  };

  let topupSeq = 0;
  const fund = async (userToken: string, amountCents: number) => {
    topupSeq += 1;
    await request(app.getHttpServer())
      .post('/account/topup')
      .set('Cookie', sessionCookie(userToken))
      .set('Idempotency-Key', `topup-${topupSeq}`)
      .send({ amountCents })
      .expect(201);
  };

  const statusOf = async (paymentId: string) =>
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { status: true },
      })
    ).status;

  const eventsFor = (paymentId: string) =>
    prisma.webhookEvent.findMany({ where: { paymentId } });

  const assertAllInvariants = async () => {
    await assertLedgerInvariants(app);
    await assertPaymentInvariants(app);
  };

  // ---------- tests ----------

  describe('expiring a due payment', () => {
    it('flips it to EXPIRED and writes exactly one fresh outbox row (invariant 7)', async () => {
      const paymentId = await createPayment();
      await makeDue(paymentId);

      await worker.expireDuePayments();

      expect(await statusOf(paymentId)).toBe('EXPIRED');
      const events = await eventsFor(paymentId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        lockedUntil: null,
        deliveredAt: null,
      });
      await assertAllInvariants();
    });

    it('expires a payment whose expiresAt is exactly now (mirror of approve: expiresAt > now)', async () => {
      const paymentId = await createPayment();
      await prisma.payment.update({
        where: { id: paymentId },
        data: { expiresAt: new Date() },
      });

      await worker.expireDuePayments();

      expect(await statusOf(paymentId)).toBe('EXPIRED');
      await assertAllInvariants();
    });

    it('moves no money', async () => {
      const user = await createUser(app);
      await fund(user.token, 5000);
      const paymentId = await createPayment(2500);
      await makeDue(paymentId);
      const transfersBefore = await prisma.transfer.count();
      const balancesBefore = await prisma.account.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, balanceCents: true },
      });

      await worker.expireDuePayments();

      expect(await prisma.transfer.count()).toBe(transfersBefore);
      expect(
        await prisma.account.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, balanceCents: true },
        }),
      ).toEqual(balancesBefore);
      await assertAllInvariants();
    });

    it('expires several due payments in one tick, each with its own outbox row', async () => {
      const ids = [
        await createPayment(),
        await createPayment(),
        await createPayment(),
      ];
      for (const id of ids) await makeDue(id);

      await worker.expireDuePayments();

      for (const id of ids) {
        expect(await statusOf(id)).toBe('EXPIRED');
        expect(await eventsFor(id)).toHaveLength(1);
      }
      await assertAllInvariants();
    });
  });

  describe('what it must not touch', () => {
    it('leaves a PENDING payment that is not due yet alone', async () => {
      const paymentId = await createPayment();

      await worker.expireDuePayments();

      expect(await statusOf(paymentId)).toBe('PENDING');
      expect(await eventsFor(paymentId)).toHaveLength(0);
      await assertAllInvariants();
    });

    it('never touches a paid payment, even after its expiresAt has passed', async () => {
      const user = await createUser(app);
      await fund(user.token, 2500);
      const paymentId = await createPayment(2500);
      await request(app.getHttpServer())
        .post(`/payments/${paymentId}/approve`)
        .set('Cookie', sessionCookie(user.token))
        .expect(201);
      await makeDue(paymentId);

      await worker.expireDuePayments();

      expect(await statusOf(paymentId)).toBe('SUCCESS');
      expect(await eventsFor(paymentId)).toHaveLength(1);
      await assertAllInvariants();
    });

    it('is idempotent: a second tick creates no duplicate outbox rows and does not fail', async () => {
      const paymentId = await createPayment();
      await makeDue(paymentId);

      await worker.expireDuePayments();
      const [first] = await eventsFor(paymentId);
      await worker.expireDuePayments();

      const events = await eventsFor(paymentId);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(first.id);
      await assertAllInvariants();
    });

    it('does nothing on an empty table', async () => {
      await worker.expireDuePayments();
      expect(await prisma.webhookEvent.count()).toBe(0);
    });
  });

  describe('backlog after an outage', () => {
    it('drains more than one batch (250 overdue) in a single tick', async () => {
      await insertDuePayments(250);

      await worker.expireDuePayments();

      expect(await prisma.payment.count({ where: { status: 'PENDING' } })).toBe(
        0,
      );
      expect(await prisma.payment.count({ where: { status: 'EXPIRED' } })).toBe(
        250,
      );
      expect(await prisma.webhookEvent.count()).toBe(250);
      await assertAllInvariants();
    });

    it('drains a backlog that is an exact multiple of the batch size (200)', async () => {
      await insertDuePayments(200);

      await worker.expireDuePayments();

      expect(await prisma.payment.count({ where: { status: 'EXPIRED' } })).toBe(
        200,
      );
      expect(await prisma.webhookEvent.count()).toBe(200);
      await assertAllInvariants();
    });

    it('only expires the due ones out of a mixed backlog', async () => {
      await insertDuePayments(150);
      const notDue = await createPayment();

      await worker.expireDuePayments();

      expect(await statusOf(notDue)).toBe('PENDING');
      expect(await prisma.payment.count({ where: { status: 'EXPIRED' } })).toBe(
        150,
      );
      await assertAllInvariants();
    });
  });

  describe('effects on the rest of the API', () => {
    it('approving an expired payment is rejected with 409, and no money moves', async () => {
      const user = await createUser(app);
      await fund(user.token, 5000);
      const paymentId = await createPayment(2500);
      await makeDue(paymentId);
      await worker.expireDuePayments();

      await request(app.getHttpServer())
        .post(`/payments/${paymentId}/approve`)
        .set('Cookie', sessionCookie(user.token))
        .expect(409);

      expect(await statusOf(paymentId)).toBe('EXPIRED');
      await assertAllInvariants();
    });

    it('GET /payments/:id reports EXPIRED', async () => {
      const paymentId = await createPayment();
      await makeDue(paymentId);
      await worker.expireDuePayments();

      const res = await request(app.getHttpServer())
        .get(`/payments/${paymentId}`)
        .set('Authorization', `Bearer ${store.secretKey}`)
        .expect(200);

      expect(res.body.status).toBe('EXPIRED');
    });

    it('frees the orderId: the store can create a new payment for the same order', async () => {
      orderSeq += 1;
      const body = {
        amountCents: 2500,
        orderId: `order-${orderSeq}`,
        returnUrl: 'https://shop.example.com/return',
      };
      const first = await request(app.getHttpServer())
        .post('/payments')
        .set('Authorization', `Bearer ${store.secretKey}`)
        .set('Idempotency-Key', `retry-a-${orderSeq}`)
        .send(body)
        .expect(201);
      await makeDue(first.body.id);

      // Before the worker runs, the overdue PENDING row still holds the order.
      await request(app.getHttpServer())
        .post('/payments')
        .set('Authorization', `Bearer ${store.secretKey}`)
        .set('Idempotency-Key', `retry-b-${orderSeq}`)
        .send(body)
        .expect(409);

      await worker.expireDuePayments();

      await request(app.getHttpServer())
        .post('/payments')
        .set('Authorization', `Bearer ${store.secretKey}`)
        .set('Idempotency-Key', `retry-c-${orderSeq}`)
        .send(body)
        .expect(201);
      await assertAllInvariants();
    });
  });

  describe('concurrency', () => {
    it('two ticks running at once still write exactly one outbox row per payment', async () => {
      await insertDuePayments(150);

      await Promise.all([
        worker.expireDuePayments(),
        worker.expireDuePayments(),
      ]);
      // The in-process guard may have skipped the second call; a third
      // sequential tick picks up anything left.
      await worker.expireDuePayments();

      expect(await prisma.payment.count({ where: { status: 'EXPIRED' } })).toBe(
        150,
      );
      expect(await prisma.webhookEvent.count()).toBe(150);
      await assertAllInvariants();
    });

    it('an approval that claimed the row first wins; the worker does not overwrite it or fail its batch', async () => {
      // Simulates an approve whose claim ran just before expiresAt and is
      // still inside its transaction (row locked) when the worker runs.
      await createUser(app);
      const { id: userId } = await prisma.user.findUniqueOrThrow({
        where: { email: 'ali@test.com' },
        select: { id: true },
      });
      const raced = await createPayment();
      const bystander = await createPayment();
      await makeDue(raced);
      await makeDue(bystander);

      let signalLocked!: () => void;
      const locked = new Promise<void>((r) => (signalLocked = r));
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));

      const approveTx = prisma.$transaction(
        async (tx) => {
          await tx.payment.update({
            where: { id: raced },
            data: { status: 'SUCCESS', userId },
          });
          await tx.webhookEvent.create({ data: { paymentId: raced } });
          signalLocked();
          await released;
        },
        { timeout: 10_000 },
      );

      await locked;
      const tick = worker.expireDuePayments();
      // Give the worker time to reach the locked row and block on it.
      await new Promise((r) => setTimeout(r, 300));
      release();
      await approveTx;
      await tick;

      expect(await statusOf(raced)).toBe('SUCCESS');
      expect(await eventsFor(raced)).toHaveLength(1);
      // If the worker had tried to overwrite SUCCESS, the CHECK would have
      // rolled back its whole batch and left the bystander PENDING.
      expect(await statusOf(bystander)).toBe('EXPIRED');
      expect(await eventsFor(bystander)).toHaveLength(1);
    });

    it('expiring and approving many payments at the deadline: each ends in exactly one terminal state', async () => {
      const user = await createUser(app);
      await fund(user.token, 100_000);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(await createPayment(100));

      const deadline = new Date(Date.now() + 150);
      await prisma.payment.updateMany({
        where: { id: { in: ids } },
        data: { expiresAt: deadline },
      });

      const approvals = ids.map(async (id, i) => {
        await new Promise((r) => setTimeout(r, 100 + i * 5));
        return request(app.getHttpServer())
          .post(`/payments/${id}/approve`)
          .set('Cookie', sessionCookie(user.token));
      });
      const ticks = (async () => {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 50));
          await worker.expireDuePayments();
        }
      })();
      const results = await Promise.all(approvals);
      await ticks;
      await worker.expireDuePayments();

      for (const [i, id] of ids.entries()) {
        const status = await statusOf(id);
        expect(['SUCCESS', 'EXPIRED']).toContain(status);
        expect(results[i].status).toBe(status === 'SUCCESS' ? 201 : 409);
      }
      await assertAllInvariants();
    });
  });
});
