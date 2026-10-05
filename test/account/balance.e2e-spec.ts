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

describe('Balance (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const balance = (auth: string | null) => {
    let req = request(app.getHttpServer()).get('/account/balance');
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    return req;
  };

  const topup = (token: string, amountCents: number, key: string) =>
    request(app.getHttpServer())
      .post('/account/topup')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ amountCents })
      .expect(201);

  // Stores can't top up and approve doesn't exist yet, so fund the store's
  // account with a ledger-consistent TOPUP transfer written directly.
  const fundStore = async (storeId: string, amountCents: number) => {
    const { accountId } = await prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { accountId: true },
    });
    const system = await prisma.account.findFirstOrThrow({
      where: { type: 'SYSTEM' },
    });
    await prisma.$transaction([
      prisma.transfer.create({
        data: {
          amountCents,
          type: 'TOPUP',
          fromAccountId: system.id,
          toAccountId: accountId,
          requestHash: 'test-fund-store',
          topupIdempotencyKey: 'test-fund-store',
        },
      }),
      prisma.account.update({
        where: { id: accountId },
        data: { balanceCents: { increment: amountCents } },
      }),
      prisma.account.update({
        where: { id: system.id },
        data: { balanceCents: { decrement: amountCents } },
      }),
    ]);
  };

  describe('users', () => {
    it('returns 0 for a new user', async () => {
      const { token } = await createUser(app);

      const res = await balance(token).expect(200);

      expect(res.body).toEqual({ balanceCents: 0 });
    });

    it('returns JSON with a numeric balanceCents (BigInt is converted)', async () => {
      const { token } = await createUser(app);
      await topup(token, 1234, 'key-1');

      const res = await balance(token)
        .expect(200)
        .expect('Content-Type', /application\/json/);

      expect(typeof res.body.balanceCents).toBe('number');
      expect(res.body.balanceCents).toBe(1234);
    });

    it('matches the sum of several top-ups', async () => {
      const { token } = await createUser(app);
      await topup(token, 1000, 'key-1');
      await topup(token, 2500, 'key-2');
      await topup(token, 1, 'key-3');

      const res = await balance(token).expect(200);

      expect(res.body).toEqual({ balanceCents: 3501 });
      await assertLedgerInvariants(app);
    });

    it("does not change on an idempotent replay", async () => {
      const { token } = await createUser(app);
      await topup(token, 1000, 'key-1');
      await topup(token, 1000, 'key-1');

      const res = await balance(token).expect(200);

      expect(res.body).toEqual({ balanceCents: 1000 });
      await assertLedgerInvariants(app);
    });

    it("sees only its own balance, not another user's", async () => {
      const { token: ali } = await createUser(app, 'ali@test.com');
      const { token: sara } = await createUser(app, 'sara@test.com');
      await topup(ali, 700, 'key-1');
      await topup(sara, 300, 'key-1');

      expect((await balance(ali).expect(200)).body).toEqual({
        balanceCents: 700,
      });
      expect((await balance(sara).expect(200)).body).toEqual({
        balanceCents: 300,
      });
      await assertLedgerInvariants(app);
    });
  });

  describe('stores', () => {
    it('returns 0 for a new store', async () => {
      const { token } = await createStore(app);

      const res = await balance(token).expect(200);

      expect(res.body).toEqual({ balanceCents: 0 });
    });

    it("reads the store's own account, not a user's", async () => {
      const store = await createStore(app);
      const { token: userToken } = await createUser(app);
      await topup(userToken, 5000, 'key-1');
      await fundStore(store.storeId, 800);

      expect((await balance(store.token).expect(200)).body).toEqual({
        balanceCents: 800,
      });
      expect((await balance(userToken).expect(200)).body).toEqual({
        balanceCents: 5000,
      });
      await assertLedgerInvariants(app);
    });
  });

  describe('auth', () => {
    it('rejects a request without a session with 401', async () => {
      await balance(null).expect(401);
    });

    it('rejects an unknown token with 401', async () => {
      await balance('not-a-real-token').expect(401);
    });

    it('rejects an API secret key used as a session token with 401', async () => {
      const { secretKey } = await createStore(app);

      await balance(secretKey).expect(401);
    });

    it('rejects a logged-out session with 401', async () => {
      const { token } = await createUser(app);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect((res) => expect(res.status).toBeLessThan(300));

      await balance(token).expect(401);
    });

    it('returns 401 when the session outlives its user row', async () => {
      const { token } = await createUser(app);
      await prisma.user.delete({ where: { email: 'ali@test.com' } });

      await balance(token).expect(401);
    });
  });
});
