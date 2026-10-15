import { INestApplication } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import Redis from 'ioredis';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  assertLedgerInvariants,
  assertPaymentInvariants,
  createStore,
  createTestApp,
  createUser,
  resetState,
  session,
  TEST_PIN,
} from '../helpers';
import {
  AppProcess,
  holdRowLock,
  Receiver,
  waitFor,
  waitForBlockedOnLock,
  waitForNoOpenTransactions,
} from './harness';

// Runs the built app as a child process, SIGKILLs it at chosen points, restarts
// it, and checks that nothing broke. Setup and checks use an in-process app on
// the same test DB and Redis; every crashing request goes to the child.
describe('Crash recovery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let receiver: Receiver;
  let child: AppProcess | undefined;

  beforeAll(async () => {
    execSync('npx nest build', { stdio: 'inherit' });
    app = await createTestApp();
    prisma = app.get(PrismaService);
    receiver = await Receiver.start();
  }, 120_000);

  beforeEach(async () => {
    await resetState(app);
    receiver.reset();
    AppProcess.logs = [];
  }, 30_000);

  afterEach(async () => {
    await child?.kill();
    child = undefined;
    // Leave no leftover transaction from a killed process for the next test's TRUNCATE
    await waitForNoOpenTransactions();
  }, 60_000);

  afterAll(async () => {
    receiver?.close();
    await app?.close();
  });

  const local = () => request(app.getHttpServer());
  const remote = () => request(child!.url);

  async function expectClean() {
    const report = await app.get(ReconciliationService).run();
    expect(report, JSON.stringify(report)).toMatchObject({ ok: true });
    await assertLedgerInvariants(app);
    await assertPaymentInvariants(app);
  }

  // Requests the kill interrupts get no response; that's the expected outcome.
  const statusOf = (req: request.Test) =>
    req.then(
      (r) => r.status,
      () => 'no response' as const,
    );

  async function fund(token: string, amountCents: number) {
    await local()
      .post('/account/topup')
      .set(session(token))
      .set('Idempotency-Key', `fund-${randomUUID()}`)
      .send({ amountCents, pin: TEST_PIN })
      .expect(201);
  }

  const createPayment = (
    http: () => request.Agent | ReturnType<typeof request>,
    secretKey: string,
    amountCents: number,
    key = randomUUID(),
  ) =>
    http()
      .post('/payments')
      .set('Authorization', `Bearer ${secretKey}`)
      .set('Idempotency-Key', key)
      .send({
        amountCents,
        orderId: key,
        returnUrl: 'https://shop.example.com/done',
      });

  async function balanceOf(accountOwner: { accountId: string }) {
    const a = await prisma.account.findUniqueOrThrow({
      where: { id: accountOwner.accountId },
    });
    return a.balanceCents;
  }

  async function world() {
    const store = await createStore(app, { webhookUrl: receiver.url });
    const { token } = await createUser(app);
    await fund(token, 1000);
    const user = await prisma.user.findFirstOrThrow({
      select: { id: true, accountId: true },
    });
    const storeRow = await prisma.store.findUniqueOrThrow({
      where: { id: store.storeId },
      select: { accountId: true },
    });
    return { store, storeRow, token, user };
  }

  it('approve: killed mid-transaction, nothing is half-applied, and a retry succeeds once', async () => {
    const { store, storeRow, token, user } = await world();
    const { body: payment } = await createPayment(
      local,
      store.secretKey,
      300,
    ).expect(201);
    child = await AppProcess.start();

    // The store credit is approve's last statement: by the time it blocks, the
    // payment is SUCCESS, the user is debited, and the transfer and event exist.
    const lock = await holdRowLock('Account', storeRow.accountId);
    const approve = statusOf(
      remote()
        .post(`/payments/${payment.id}/approve`)
        .set(session(token))
        .send({ pin: TEST_PIN }),
    );
    await waitForBlockedOnLock();
    await child.kill();
    await lock.release();
    await waitForNoOpenTransactions();

    expect(await approve).toBe('no response');
    const after = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(after.status).toBe('PENDING');
    expect(after.userId).toBeNull();
    expect(await balanceOf(user)).toBe(1000n);
    expect(await balanceOf(storeRow)).toBe(0n);
    expect(await prisma.transfer.count({ where: { type: 'PAYMENT' } })).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(0);
    await expectClean();

    child = await AppProcess.start();
    await remote()
      .post(`/payments/${payment.id}/approve`)
      .set(session(token))
      .send({ pin: TEST_PIN })
      .expect(201);
    await remote()
      .post(`/payments/${payment.id}/approve`)
      .set(session(token))
      .send({ pin: TEST_PIN })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));

    expect(await balanceOf(user)).toBe(700n);
    expect(await balanceOf(storeRow)).toBe(300n);
    await waitFor(
      'the event to be delivered',
      async () =>
        (await prisma.webhookEvent.count({
          where: { status: 'DELIVERED' },
        })) === 1,
    );
    await expectClean();
  }, 60_000);

  it('top-up: killed mid-transaction, then the same idempotency key credits exactly once', async () => {
    const { token, user } = await world();
    const system = await prisma.account.findFirstOrThrow({
      where: { type: 'SYSTEM' },
    });
    child = await AppProcess.start();

    // SYSTEM's debit is the top-up's last statement
    const lock = await holdRowLock('Account', system.id);
    const topup = (http: typeof remote) =>
      http()
        .post('/account/topup')
        .set(session(token))
        .set('Idempotency-Key', 'crash-key')
        .send({ amountCents: 500, pin: TEST_PIN });
    const first = statusOf(topup(remote));
    await waitForBlockedOnLock();
    await child.kill();
    await lock.release();
    await waitForNoOpenTransactions();

    expect(await first).toBe('no response');
    expect(await balanceOf(user)).toBe(1000n);
    expect(
      await prisma.transfer.count({
        where: { topupIdempotencyKey: 'crash-key' },
      }),
    ).toBe(0);
    await expectClean();

    child = await AppProcess.start();
    const retry = await topup(remote);
    expect(retry.status).toBe(201);
    const again = await topup(remote);
    expect(again.status).toBeLessThan(300);
    expect(again.body).toEqual(retry.body);

    expect(await balanceOf(user)).toBe(1500n);
    expect(
      await prisma.transfer.count({
        where: { topupIdempotencyKey: 'crash-key' },
      }),
    ).toBe(1);
    await expectClean();
  }, 60_000);

  it('expiry: killed mid-batch, nothing expires half-way, and the next run expires all of them', async () => {
    const { store } = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await createPayment(local, store.secretKey, 100).expect(201)).body.id,
      );
    }
    await prisma.payment.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // The expiry batch updates all five in one statement; one locked row blocks it
    // while it holds the other four.
    const lock = await holdRowLock('Payment', ids[2]);
    child = await AppProcess.start();
    await waitForBlockedOnLock();
    await child.kill();
    await lock.release();
    await waitForNoOpenTransactions();

    expect(await prisma.payment.count({ where: { status: 'PENDING' } })).toBe(
      5,
    );
    expect(await prisma.webhookEvent.count()).toBe(0);
    await expectClean();

    child = await AppProcess.start();
    await waitFor(
      'all five to expire',
      async () =>
        (await prisma.payment.count({ where: { status: 'EXPIRED' } })) === 5,
    );
    await waitFor(
      'all five events to be delivered',
      async () =>
        (await prisma.webhookEvent.count({
          where: { status: 'DELIVERED' },
        })) === 5,
    );
    expect(new Set(receiver.received).size).toBe(5);
    await expectClean();
  }, 60_000);

  it('delivery: killed after the store got the webhook but before the write-back, it is re-sent with the same id', async () => {
    const { store, token } = await world();
    const { body: payment } = await createPayment(
      local,
      store.secretKey,
      300,
    ).expect(201);

    let crashed = false;
    receiver.handler = async () => {
      if (!crashed) {
        crashed = true;
        await child!.kill();
      }
      return 200;
    };
    child = await AppProcess.start();
    await remote()
      .post(`/payments/${payment.id}/approve`)
      .set(session(token))
      .send({ pin: TEST_PIN })
      .expect(201);

    await waitFor('the first delivery to crash the app', () => crashed);
    await waitForNoOpenTransactions();
    const event = await prisma.webhookEvent.findFirstOrThrow();
    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(0);
    expect(event.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // The lease (60 s) must run out before another worker may claim the row.
    child = await AppProcess.start();
    await waitFor(
      'the event to be re-delivered after the lease expires',
      async () =>
        (await prisma.webhookEvent.findFirstOrThrow()).status === 'DELIVERED',
      90_000,
      500,
    );
    expect(receiver.received).toEqual([event.id, event.id]);
    await expectClean();
  }, 120_000);

  it('chaos: random SIGKILLs under mixed load never break an invariant', async () => {
    const ROUNDS = 8;
    const stores = [
      await createStore(app, {
        email: 's1@test.com',
        webhookUrl: receiver.url,
      }),
      await createStore(app, {
        email: 's2@test.com',
        webhookUrl: receiver.url,
      }),
    ];
    const users: { token: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const u = await createUser(app, `u${i}@test.com`);
      await fund(u.token, 100_000);
      users.push(u);
    }
    // Some deliveries fail, so retries and backoff are crashed into too
    receiver.handler = () => (Math.random() < 0.1 ? 500 : 200);

    const created: string[] = [];
    const approved: { paymentId: string; token: string }[] = [];
    const topups = new Map<
      string,
      { token: string; amount: number; status: number | string }
    >();
    const stats = { requests: 0, noResponse: 0, pinLocked: 0, kills: 0 };
    const note = (s: number | string) => {
      stats.requests++;
      if (s === 'no response') stats.noResponse++;
      if (s === 429) stats.pinLocked++;
    };

    const env = { PAYMENTS_EXPIRY_SECONDS: '2' };
    for (let round = 0; round < ROUNDS; round++) {
      child = await AppProcess.start(env);
      let alive = true;
      const http = () => request(child!.url);

      const loops = users.map(async (u, i) => {
        while (alive) {
          const s = stores[(i + round) % stores.length];
          const res = await createPayment(
            http,
            s.secretKey,
            1 + Math.floor(Math.random() * 500),
          ).then(
            (r) => r,
            () => null,
          );
          note(res?.status ?? 'no response');
          if (res?.status === 201) {
            created.push(res.body.id);
            // Leave some unpaid so they expire under load
            if (Math.random() < 0.8) {
              const status = await statusOf(
                http()
                  .post(`/payments/${res.body.id}/approve`)
                  .set(session(u.token))
                  .send({ pin: TEST_PIN }),
              );
              note(status);
              if (status === 201)
                approved.push({ paymentId: res.body.id, token: u.token });
            }
          }
          if (Math.random() < 0.3) {
            const key = randomUUID();
            const amount = 1 + Math.floor(Math.random() * 1000);
            topups.set(key, { token: u.token, amount, status: 'no response' });
            const status = await statusOf(
              http()
                .post('/account/topup')
                .set(session(u.token))
                .set('Idempotency-Key', key)
                .send({ amountCents: amount, pin: TEST_PIN }),
            );
            note(status);
            topups.get(key)!.status = status;
          }
        }
      });

      await new Promise((r) => setTimeout(r, 300 + Math.random() * 1700));
      alive = false;
      await child.kill();
      stats.kills++;
      await Promise.all(loops);
      await waitForNoOpenTransactions();
    }

    // Every acknowledged write survived the crashes
    child = await AppProcess.start(env);
    for (const id of created) {
      expect(await prisma.payment.findUnique({ where: { id } })).not.toBeNull();
    }
    for (const { paymentId } of approved) {
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
          .status,
      ).toBe('SUCCESS');
    }

    // Unanswered top-ups: the client retries with the same key. A crash between
    // the PIN counter's INCR and DEL can leave attempts behind, so count those first.
    const redis = app.get<Redis>('REDIS_CLIENT');
    const leftoverPinAttempts: Record<string, string | null> = {};
    for (const key of await redis.keys('pin-attempts:*')) {
      leftoverPinAttempts[key] = await redis.get(key);
    }
    await Promise.all(
      (await redis.keys('pin-attempts:*')).map((k) => redis.del(k)),
    );
    let retried = 0;
    for (const [key, t] of topups) {
      if (t.status === 201) continue;
      retried++;
      const r = await remote()
        .post('/account/topup')
        .set(session(t.token))
        .set('Idempotency-Key', key)
        .send({ amountCents: t.amount, pin: TEST_PIN });
      expect(r.status, `retry of ${key}`).toBeLessThan(300);
    }
    for (const key of topups.keys()) {
      expect(
        await prisma.transfer.count({ where: { topupIdempotencyKey: key } }),
        key,
      ).toBe(1);
    }

    // Drain: every unpaid payment expires, every event is delivered
    await waitFor(
      'every payment to settle and every event to be delivered',
      async () =>
        (await prisma.payment.count({ where: { status: 'PENDING' } })) === 0 &&
        (await prisma.webhookEvent.count({
          where: { status: { not: 'DELIVERED' } },
        })) === 0,
      240_000,
      1000,
    );
    const events = await prisma.webhookEvent.findMany({ select: { id: true } });
    const received = new Set(receiver.received);
    expect(events.filter((e) => !received.has(e.id))).toEqual([]);
    await expectClean();

    const fatal = AppProcess.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('FATAL'));
    const summary = JSON.stringify(
      {
        ...stats,
        payments: await prisma.payment.groupBy({
          by: ['status'],
          _count: true,
        }),
        topups: topups.size,
        topupsRetried: retried,
        events: events.length,
        deliveries: receiver.received.length,
        duplicateDeliveries: receiver.received.length - received.size,
        leftoverPinAttempts,
        fatalLogLines: fatal,
      },
      null,
      2,
    );
    // CRASH_STATS_FILE=path writes the run's numbers out (vitest hides console output)
    if (process.env.CRASH_STATS_FILE)
      writeFileSync(process.env.CRASH_STATS_FILE, summary);

    expect(fatal).toEqual([]);
  }, 600_000);
});
