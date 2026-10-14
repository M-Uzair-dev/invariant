import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { PaymentExpiryWorker } from '../../src/payment/payment-expiry.worker';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ReconciliationWorker } from '../../src/reconciliation/reconciliation.worker';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  createStore,
  createUser,
  createTestApp,
  resetState,
  session,
  skipPinCheck,
  TEST_PIN,
  TestStore,
} from '../helpers';

describe('Reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: ReconciliationService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    reconciliation = app.get(ReconciliationService);
  });

  beforeEach(async () => {
    await resetState(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  let seq = 0;
  const fund = (token: string, amountCents: number) => {
    seq += 1;
    return http()
      .post('/account/topup')
      .set(session(token))
      .set('Idempotency-Key', `topup-${seq}`)
      .send({ amountCents, pin: TEST_PIN })
      .expect(201);
  };

  const createPayment = async (store: TestStore, amountCents: number) => {
    seq += 1;
    const res = await http()
      .post('/payments')
      .set('Authorization', `Bearer ${store.secretKey}`)
      .set('Idempotency-Key', `pay-${seq}`)
      .send({
        amountCents,
        orderId: `order-${seq}`,
        returnUrl: 'https://shop.example.com/return',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const approve = (token: string, paymentId: string) =>
    http()
      .post(`/payments/${paymentId}/approve`)
      .set(session(token))
      .send({ pin: TEST_PIN });

  const accountOfUser = async (email: string) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { accountId: true },
      })
    ).accountId;

  const accountOfStore = async (storeId: string) =>
    (
      await prisma.store.findUniqueOrThrow({
        where: { id: storeId },
        select: { accountId: true },
      })
    ).accountId;

  const systemAccount = async () =>
    (
      await prisma.account.findFirstOrThrow({
        where: { type: 'SYSTEM' },
        select: { id: true },
      })
    ).id;

  const addToBalance = (accountId: string, delta: bigint) =>
    prisma.account.update({
      where: { id: accountId },
      data: { balanceCents: { increment: delta } },
    });

  // One user funded with 1000, a store, and one payment in each status:
  // SUCCESS (300), EXPIRED (200), PENDING (100). User ends at 700, store at 300.
  interface World {
    store: TestStore;
    userToken: string;
    userAccount: string;
    storeAccount: string;
    succeeded: string;
    expired: string;
    pending: string;
  }

  const buildWorld = async (): Promise<World> => {
    const store = await createStore(app, {
      webhookUrl: 'https://shop.example.com/hooks',
    });
    const { token: userToken } = await createUser(app);
    await fund(userToken, 1000);

    const succeeded = await createPayment(store, 300);
    await approve(userToken, succeeded).expect(201);

    const expired = await createPayment(store, 200);
    await prisma.payment.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(PaymentExpiryWorker).expireDuePayments();

    const pending = await createPayment(store, 100);

    return {
      store,
      userToken,
      userAccount: await accountOfUser('ali@test.com'),
      storeAccount: await accountOfStore(store.storeId),
      succeeded,
      expired,
      pending,
    };
  };

  describe('clean state', () => {
    it('an empty ledger (SYSTEM account only) reports no drift', async () => {
      const report = await reconciliation.run();
      expect(report).toMatchObject({
        ok: true,
        conservationTotal: '0',
        balanceDrift: [],
        paymentProblems: [],
        directionProblems: [],
      });
    });

    it('top-ups and payments in every status report no drift', async () => {
      await buildWorld();
      const report = await reconciliation.run();
      expect(report).toMatchObject({
        ok: true,
        conservationTotal: '0',
        balanceDrift: [],
        paymentProblems: [],
        directionProblems: [],
      });
      expect(report.checkedAt).toBeInstanceOf(Date);
    });

    it('the report survives JSON.stringify (no bigints)', async () => {
      const w = await buildWorld();
      await addToBalance(w.userAccount, 50n);
      const report = await reconciliation.run();
      expect(() => JSON.stringify(report)).not.toThrow();
    });
  });

  describe('balances', () => {
    it('a bumped cached balance breaks conservation and shows up as drift', async () => {
      const w = await buildWorld();
      await addToBalance(w.userAccount, 50n);

      const report = await reconciliation.run();
      expect(report.ok).toBe(false);
      expect(report.conservationTotal).toBe('50');
      expect(report.balanceDrift).toEqual([
        { accountId: w.userAccount, cached: '750', ledger: '700' },
      ]);
    });

    it('a balanced pair of bumps passes conservation but not the per-account check', async () => {
      const w = await buildWorld();
      const system = await systemAccount();
      await addToBalance(w.userAccount, 50n);
      await addToBalance(system, -50n);

      const report = await reconciliation.run();
      expect(report.ok).toBe(false);
      expect(report.conservationTotal).toBe('0');
      expect(report.balanceDrift.map((d) => d.accountId).sort()).toEqual(
        [w.userAccount, system].sort(),
      );
    });
  });

  describe('payment ↔ transfer ↔ event', () => {
    it('SUCCESS without its webhook event', async () => {
      const w = await buildWorld();
      await prisma.webhookEvent.delete({ where: { paymentId: w.succeeded } });

      const report = await reconciliation.run();
      expect(report.ok).toBe(false);
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({
          paymentId: w.succeeded,
          status: 'SUCCESS',
          eventId: null,
        }),
      ]);
      expect(report.balanceDrift).toEqual([]);
    });

    it('SUCCESS without its transfer (balances moved, ledger did not)', async () => {
      const w = await buildWorld();
      await prisma.transfer.delete({ where: { paymentId: w.succeeded } });

      const report = await reconciliation.run();
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({
          paymentId: w.succeeded,
          transferId: null,
        }),
      ]);
      expect(report.balanceDrift.map((d) => d.accountId).sort()).toEqual(
        [w.userAccount, w.storeAccount].sort(),
      );
    });

    it("SUCCESS whose transfer amount differs from the payment's", async () => {
      const w = await buildWorld();
      await prisma.transfer.update({
        where: { paymentId: w.succeeded },
        data: { amountCents: 250n },
      });

      const report = await reconciliation.run();
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({
          paymentId: w.succeeded,
          amountCents: '300',
          transferAmountCents: '250',
        }),
      ]);
    });

    it('EXPIRED without its webhook event', async () => {
      const w = await buildWorld();
      await prisma.webhookEvent.delete({ where: { paymentId: w.expired } });

      const report = await reconciliation.run();
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({
          paymentId: w.expired,
          status: 'EXPIRED',
          eventId: null,
        }),
      ]);
    });

    it('EXPIRED with a transfer (money moved for a payment never approved)', async () => {
      const w = await buildWorld();
      await prisma.transfer.create({
        data: {
          type: 'PAYMENT',
          amountCents: 200n,
          fromAccountId: w.userAccount,
          toAccountId: w.storeAccount,
          paymentId: w.expired,
        },
      });
      await addToBalance(w.userAccount, -200n);
      await addToBalance(w.storeAccount, 200n);

      const report = await reconciliation.run();
      expect(report.balanceDrift).toEqual([]);
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({ paymentId: w.expired, status: 'EXPIRED' }),
      ]);
    });

    it('PENDING with a webhook event', async () => {
      const w = await buildWorld();
      await prisma.webhookEvent.create({ data: { paymentId: w.pending } });

      const report = await reconciliation.run();
      expect(report.paymentProblems).toEqual([
        expect.objectContaining({ paymentId: w.pending, status: 'PENDING' }),
      ]);
    });
  });

  describe('direction', () => {
    it('a payment credited to the wrong store, with balances kept consistent, is only caught here', async () => {
      const w = await buildWorld();
      const other = await createStore(app, { email: 'other@test.com' });
      const otherAccount = await accountOfStore(other.storeId);

      const transfer = await prisma.transfer.update({
        where: { paymentId: w.succeeded },
        data: { toAccountId: otherAccount },
      });
      await addToBalance(w.storeAccount, -300n);
      await addToBalance(otherAccount, 300n);

      const report = await reconciliation.run();
      expect(report.ok).toBe(false);
      expect(report.conservationTotal).toBe('0');
      expect(report.balanceDrift).toEqual([]);
      expect(report.paymentProblems).toEqual([]);
      expect(report.directionProblems).toEqual([
        {
          transferId: transfer.id,
          type: 'PAYMENT',
          fromAccountId: w.userAccount,
          toAccountId: otherAccount,
          amountCents: '300',
        },
      ]);
    });

    it('a payment charged to someone other than the payer', async () => {
      const w = await buildWorld();
      const { token: otherToken } = await createUser(app, 'bo@test.com');
      await fund(otherToken, 1000);
      const otherAccount = await accountOfUser('bo@test.com');

      await prisma.transfer.update({
        where: { paymentId: w.succeeded },
        data: { fromAccountId: otherAccount },
      });
      await addToBalance(w.userAccount, 300n);
      await addToBalance(otherAccount, -300n);

      const report = await reconciliation.run();
      expect(report.balanceDrift).toEqual([]);
      expect(report.directionProblems).toEqual([
        expect.objectContaining({ fromAccountId: otherAccount }),
      ]);
    });

    it('a top-up into a store account', async () => {
      const w = await buildWorld();
      const system = await systemAccount();
      const transfer = await prisma.transfer.create({
        data: {
          type: 'TOPUP',
          amountCents: 500n,
          fromAccountId: system,
          toAccountId: w.storeAccount,
          topupIdempotencyKey: 'rogue',
          requestHash: 'rogue',
        },
      });
      await addToBalance(w.storeAccount, 500n);
      await addToBalance(system, -500n);

      const report = await reconciliation.run();
      expect(report.balanceDrift).toEqual([]);
      expect(report.directionProblems).toEqual([
        expect.objectContaining({ transferId: transfer.id, type: 'TOPUP' }),
      ]);
    });

    it('a top-up that does not come from SYSTEM', async () => {
      const w = await buildWorld();
      await createUser(app, 'bo@test.com');
      const otherAccount = await accountOfUser('bo@test.com');
      const transfer = await prisma.transfer.create({
        data: {
          type: 'TOPUP',
          amountCents: 100n,
          fromAccountId: w.userAccount,
          toAccountId: otherAccount,
          topupIdempotencyKey: 'rogue',
          requestHash: 'rogue',
        },
      });
      await addToBalance(w.userAccount, -100n);
      await addToBalance(otherAccount, 100n);

      const report = await reconciliation.run();
      expect(report.balanceDrift).toEqual([]);
      expect(report.directionProblems).toEqual([
        expect.objectContaining({ transferId: transfer.id, type: 'TOPUP' }),
      ]);
    });
  });

  // These corruptions never reach reconciliation: the DB refuses them.
  describe('what the constraints already block', () => {
    it('a second transfer for the same payment (unique paymentId)', async () => {
      const w = await buildWorld();
      await expect(
        prisma.transfer.create({
          data: {
            type: 'PAYMENT',
            amountCents: 300n,
            fromAccountId: w.userAccount,
            toAccountId: w.storeAccount,
            paymentId: w.succeeded,
          },
        }),
      ).rejects.toThrow();
    });

    it('a second webhook event for the same payment (unique paymentId)', async () => {
      const w = await buildWorld();
      await expect(
        prisma.webhookEvent.create({ data: { paymentId: w.succeeded } }),
      ).rejects.toThrow();
    });

    it('a user balance below zero (CHECK)', async () => {
      const w = await buildWorld();
      await expect(addToBalance(w.userAccount, -701n)).rejects.toThrow();
    });
  });

  describe('consistent snapshot', () => {
    it('runs alongside concurrent approvals without reporting false drift', async () => {
      skipPinCheck(app);
      const store = await createStore(app, {
        webhookUrl: 'https://shop.example.com/hooks',
      });
      const { token } = await createUser(app);
      await fund(token, 10_000);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(await createPayment(store, 100));

      const [approvals, reports] = await Promise.all([
        Promise.all(ids.map((id) => approve(token, id))),
        Promise.all(Array.from({ length: 5 }, () => reconciliation.run())),
      ]);

      expect(approvals.every((r) => r.status === 201)).toBe(true);
      for (const report of reports) expect(report.ok).toBe(true);
      expect((await reconciliation.run()).ok).toBe(true);
    });
  });

  describe('worker', () => {
    it('logs fatal with the report when drift is found', async () => {
      const w = await buildWorld();
      await addToBalance(w.userAccount, 50n);
      const fatal = vi
        .spyOn(Logger.prototype, 'fatal')
        .mockImplementation(() => undefined);
      onTestFinished(() => fatal.mockRestore());

      const report = await app.get(ReconciliationWorker).reconcile();
      expect(report?.ok).toBe(false);
      expect(fatal).toHaveBeenCalledOnce();
      expect(String(fatal.mock.calls[0][0])).toContain(w.userAccount);
    });

    it('stays quiet when there is no drift', async () => {
      await buildWorld();
      const fatal = vi.spyOn(Logger.prototype, 'fatal');
      onTestFinished(() => fatal.mockRestore());

      const report = await app.get(ReconciliationWorker).reconcile();
      expect(report?.ok).toBe(true);
      expect(fatal).not.toHaveBeenCalled();
    });

    it('skips a tick while the previous one is still running, and recovers after an error', async () => {
      const worker = app.get(ReconciliationWorker);
      const spy = vi
        .spyOn(reconciliation, 'run')
        .mockRejectedValueOnce(new Error('db down'));
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      onTestFinished(() => {
        spy.mockRestore();
        error.mockRestore();
      });

      expect(await worker.reconcile()).toBeUndefined();
      expect(error).toHaveBeenCalledOnce();

      const [first, second] = await Promise.all([
        worker.reconcile(),
        worker.reconcile(),
      ]);
      expect(first?.ok).toBe(true);
      expect(second).toBeUndefined();
    });
  });
});
