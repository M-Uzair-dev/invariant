import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  assertLedgerInvariants,
  createStore,
  createTestApp,
  createUser,
  resetState,
} from '../helpers';

describe('Top-up (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    ({ token } = await createUser(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const topup = (
    amountCents: unknown = 1000,
    key: string | null = 'key-1',
    auth: string | null = token,
  ) => {
    let req = request(app.getHttpServer()).post('/account/topup');
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send({ amountCents });
  };

  const balances = async () => {
    const user = await prisma.account.findFirstOrThrow({
      where: { type: 'USER' },
    });
    const system = await prisma.account.findFirstOrThrow({
      where: { type: 'SYSTEM' },
    });
    return { user: user.balanceCents, system: system.balanceCents };
  };

  describe('happy path', () => {
    it('credits the user, debits SYSTEM and records one TOPUP transfer', async () => {
      const res = await topup(1000).expect(201);

      expect(res.body).toEqual({
        transferId: expect.any(String),
        amountCents: 1000,
      });
      expect(await balances()).toEqual({ user: 1000n, system: -1000n });

      const transfer = await prisma.transfer.findUniqueOrThrow({
        where: { id: res.body.transferId },
        include: { from: true, to: true },
      });
      expect(transfer.type).toBe('TOPUP');
      expect(transfer.from.type).toBe('SYSTEM');
      expect(transfer.to.type).toBe('USER');
      expect(transfer.topupIdempotencyKey).toBe('key-1');

      await assertLedgerInvariants(app);
    });

    it('adds up several top-ups with different keys', async () => {
      await topup(1000, 'key-1').expect(201);
      await topup(2500, 'key-2').expect(201);

      expect(await balances()).toEqual({ user: 3500n, system: -3500n });
      await assertLedgerInvariants(app);
    });

    it('lets two users use the same idempotency key', async () => {
      const other = await createUser(app, 'other@test.com');
      const a = await topup(1000, 'key-1').expect(201);
      const b = await topup(1000, 'key-1', other.token).expect(201);

      expect(a.body.transferId).not.toBe(b.body.transferId);
      expect(await prisma.transfer.count()).toBe(2);
      await assertLedgerInvariants(app);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for the same key and amount', async () => {
      const first = await topup(1000).expect(201);
      const second = await topup(1000).expect(201);

      expect(second.body).toEqual(first.body);
      expect(await prisma.transfer.count()).toBe(1);
      expect(await balances()).toEqual({ user: 1000n, system: -1000n });
      await assertLedgerInvariants(app);
    });

    it('rejects the same key with a different amount (422) and moves no money', async () => {
      await topup(1000).expect(201);
      await topup(2000).expect(422);

      expect(await prisma.transfer.count()).toBe(1);
      expect(await balances()).toEqual({ user: 1000n, system: -1000n });
      await assertLedgerInvariants(app);
    });

    it('concurrent requests with the same key credit exactly once', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => topup(1000)),
      );

      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(results.map((r) => r.body.transferId)).size).toBe(1);
      expect(await prisma.transfer.count()).toBe(1);
      expect(await balances()).toEqual({ user: 1000n, system: -1000n });
      await assertLedgerInvariants(app);
    });

    it('concurrent requests with different keys all land', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => topup(1000, `key-${i}`)),
      );

      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(await prisma.transfer.count()).toBe(10);
      expect(await balances()).toEqual({ user: 10_000n, system: -10_000n });
      await assertLedgerInvariants(app);
    });
  });

  describe('assertLedgerInvariants', () => {
    it('catches a balance that drifts from the ledger', async () => {
      await topup(1000).expect(201);
      await prisma.account.updateMany({
        where: { type: 'USER' },
        data: { balanceCents: { increment: 1 } },
      });

      await expect(assertLedgerInvariants(app)).rejects.toThrow();
    });
  });

  describe('validation', () => {
    it('requires the Idempotency-Key header (400)', async () => {
      await topup(1000, null).expect(400);
    });

    it('rejects an Idempotency-Key over 255 characters (400)', async () => {
      await topup(1000, 'k'.repeat(256)).expect(400);
    });

    it.each([
      ['zero', 0],
      ['negative', -100],
      ['fractional', 10.5],
      ['a string', '1000'],
      ['over the max', 100_000_001],
    ])('rejects an amount that is %s (400)', async (_, amount) => {
      await topup(amount).expect(400);
      expect(await prisma.transfer.count()).toBe(0);
    });

    it('rejects a missing amount (400)', async () => {
      await request(app.getHttpServer())
        .post('/account/topup')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-1')
        .send({})
        .expect(400);
    });

    it('rejects unknown fields (400)', async () => {
      await request(app.getHttpServer())
        .post('/account/topup')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-1')
        .send({ amountCents: 1000, toAccountId: 'someone-else' })
        .expect(400);
    });
  });

  describe('auth', () => {
    it('rejects requests without a session (401)', async () => {
      await topup(1000, 'key-1', null).expect(401);
    });

    it('rejects a store session (403)', async () => {
      const store = await createStore(app);
      await topup(1000, 'key-1', store.token).expect(403);
      expect(await prisma.transfer.count()).toBe(0);
    });
  });
});
