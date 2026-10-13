import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PIN_LOCK_SECONDS, PIN_MAX_ATTEMPTS } from '../../src/pin/pin.service';
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
  TestStore,
} from '../helpers';

const WRONG_PIN = '000000';

describe('Approval PIN (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let store: TestStore;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    redis = app.get<Redis>('REDIS_CLIENT');
  });

  beforeEach(async () => {
    await resetState(app);
    store = await createStore(app, {
      webhookUrl: 'https://shop.example.com/hooks',
    });
    ({ token } = await createUser(app));
    ({ id: userId } = await prisma.user.findUniqueOrThrow({
      where: { email: 'ali@test.com' },
      select: { id: true },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  let seq = 0;
  const topup = (pin: unknown, amountCents = 1000) => {
    seq += 1;
    return http()
      .post('/account/topup')
      .set(session(token))
      .set('Idempotency-Key', `topup-${seq}`)
      .send(pin === undefined ? { amountCents } : { amountCents, pin });
  };

  const createPayment = async (amountCents = 500) => {
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

  const approve = (paymentId: string, pin: unknown) =>
    http()
      .post(`/payments/${paymentId}/approve`)
      .set(session(token))
      .send(pin === undefined ? {} : { pin });

  const balance = async () =>
    (await http().get('/account/balance').set(session(token)).expect(200))
      .body as { balanceCents: number };

  const lockOut = async () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++)
      await topup(WRONG_PIN).expect(403);
  };

  describe('signup', () => {
    it('stores a bcrypt hash, never the PIN itself', async () => {
      const { pinHash } = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { pinHash: true },
      });
      expect(pinHash).toMatch(/^\$2[aby]\$12\$/);
      expect(pinHash).not.toContain(TEST_PIN);
    });

    it.each([
      ['missing', undefined],
      ['5 digits', '12345'],
      ['7 digits', '1234567'],
      ['letters', '12345a'],
      ['a number, not a string', 123456],
      ['padded with spaces', ' 123456'],
    ])('rejects a PIN that is %s (400)', async (_, pin) => {
      await http()
        .post('/auth/signup-user')
        .send({ name: 'Bo', email: 'bo@test.com', password: 'secret123', pin })
        .expect(400);
    });

    it('stores do not get a PIN field (400)', async () => {
      await http()
        .post('/auth/signup-store')
        .send({
          name: 'Shop2',
          email: 'shop2@test.com',
          password: 'secret123',
          pin: TEST_PIN,
        })
        .expect(400);
    });
  });

  describe('top-up', () => {
    it('credits with the right PIN', async () => {
      await topup(TEST_PIN).expect(201);
      expect(await balance()).toEqual({ balanceCents: 1000 });
    });

    it('refuses a wrong PIN (403) and credits nothing', async () => {
      await topup(WRONG_PIN).expect(403);
      expect(await balance()).toEqual({ balanceCents: 0 });
      expect(await prisma.transfer.count()).toBe(0);
      await assertLedgerInvariants(app);
    });

    it.each([
      ['missing', undefined],
      ['malformed', '12ab56'],
    ])('rejects a %s PIN (400)', async (_, pin) => {
      await topup(pin).expect(400);
    });
  });

  describe('approve', () => {
    it('charges with the right PIN', async () => {
      await topup(TEST_PIN, 1000).expect(201);
      const paymentId = await createPayment(500);
      await approve(paymentId, TEST_PIN).expect(201);
      expect(await balance()).toEqual({ balanceCents: 500 });
    });

    it('refuses a wrong PIN (403): the payment stays PENDING and no money moves', async () => {
      await topup(TEST_PIN, 1000).expect(201);
      const paymentId = await createPayment(500);

      await approve(paymentId, WRONG_PIN).expect(403);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('PENDING');
      expect(payment.userId).toBeNull();
      expect(await balance()).toEqual({ balanceCents: 1000 });
      await assertLedgerInvariants(app);
      await assertPaymentInvariants(app);
    });

    it('a wrong PIN can be followed by the right one', async () => {
      await topup(TEST_PIN, 1000).expect(201);
      const paymentId = await createPayment(500);
      await approve(paymentId, WRONG_PIN).expect(403);
      await approve(paymentId, TEST_PIN).expect(201);
    });

    it.each([
      ['missing', undefined],
      ['malformed', 'abcdef'],
    ])('rejects a %s PIN (400)', async (_, pin) => {
      const paymentId = await createPayment(500);
      await approve(paymentId, pin).expect(400);
    });
  });

  describe('attempt limit', () => {
    it(`locks after ${PIN_MAX_ATTEMPTS} wrong PINs (429), even for the right PIN`, async () => {
      await lockOut();
      await topup(TEST_PIN).expect(429);
      expect(await balance()).toEqual({ balanceCents: 0 });
    });

    it('the lockout covers approve too', async () => {
      await topup(TEST_PIN, 1000).expect(201);
      const paymentId = await createPayment(500);
      await lockOut();
      await approve(paymentId, TEST_PIN).expect(429);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
          .status,
      ).toBe('PENDING');
    });

    it('a correct PIN resets the count', async () => {
      for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++)
        await topup(WRONG_PIN).expect(403);
      await topup(TEST_PIN).expect(201);
      for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++)
        await topup(WRONG_PIN).expect(403);
      await topup(TEST_PIN).expect(201);
    });

    it('the lock window has a TTL, and the lock lifts when it runs out', async () => {
      await lockOut();
      const key = `pin-attempts:${userId}`;
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(PIN_LOCK_SECONDS);

      await redis.del(key); // what the TTL expiring does
      await topup(TEST_PIN).expect(201);
    });

    it('parallel guesses cannot get past the limit: exactly 5 are compared', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => topup(WRONG_PIN)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 403)).toHaveLength(PIN_MAX_ATTEMPTS);
      expect(statuses.filter((s) => s === 429)).toHaveLength(
        20 - PIN_MAX_ATTEMPTS,
      );
    });

    it('is per user: one locked-out user does not lock another', async () => {
      await lockOut();
      const other = await createUser(app, 'bo@test.com');
      await http()
        .post('/account/topup')
        .set(session(other.token))
        .set('Idempotency-Key', 'other-1')
        .send({ amountCents: 1000, pin: TEST_PIN })
        .expect(201);
    });
  });

  describe('PATCH /profile/pin (change with the current PIN)', () => {
    const change = (currentPin: string, newPin: string) =>
      http()
        .patch('/profile/pin')
        .set(session(token))
        .send({ currentPin, newPin });

    it('changes the PIN: the new one works, the old one does not', async () => {
      await change(TEST_PIN, '654321').expect(204);
      await topup(TEST_PIN).expect(403);
      await topup('654321').expect(201);
    });

    it('refuses a wrong current PIN (403) and keeps the old PIN', async () => {
      await change(WRONG_PIN, '654321').expect(403);
      await topup(TEST_PIN).expect(201);
    });

    it('wrong current PINs count toward the lockout', async () => {
      for (let i = 0; i < PIN_MAX_ATTEMPTS; i++)
        await change(WRONG_PIN, '654321').expect(403);
      await change(TEST_PIN, '654321').expect(429);
      await topup(TEST_PIN).expect(429);
    });

    it('rejects a malformed new PIN (400)', async () => {
      await change(TEST_PIN, '12345').expect(400);
      await topup(TEST_PIN).expect(201);
    });

    it('is for users only: a store session gets 403', async () => {
      await http()
        .patch('/profile/pin')
        .set(session(store.token))
        .send({ currentPin: TEST_PIN, newPin: '654321' })
        .expect(403);
    });

    it('needs a session (401)', async () => {
      await http()
        .patch('/profile/pin')
        .send({ currentPin: TEST_PIN, newPin: '654321' })
        .expect(401);
    });
  });

  describe('PATCH /profile/pin/forgot (reset with the password)', () => {
    const reset = (password: string, newPin: string) =>
      http()
        .patch('/profile/pin/forgot')
        .set(session(token))
        .send({ password, newPin });

    it('sets a new PIN: the new one works, the old one does not', async () => {
      await reset('secret123', '654321').expect(204);
      await topup(TEST_PIN).expect(403);
      await topup('654321').expect(201);
    });

    it('refuses a wrong password (400) and keeps the old PIN', async () => {
      await reset('wrong-password', '654321').expect(400);
      await topup(TEST_PIN).expect(201);
    });

    it('lifts a lockout', async () => {
      await lockOut();
      await reset('secret123', '654321').expect(204);
      await topup('654321').expect(201);
    });

    it('lets a user created before PINs (empty hash) set one', async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { pinHash: '' },
      });
      await topup(TEST_PIN).expect(403);

      await reset('secret123', '654321').expect(204);
      await topup('654321').expect(201);
    });

    it('is for users only: a store session gets 403', async () => {
      await http()
        .patch('/profile/pin/forgot')
        .set(session(store.token))
        .send({ password: 'secret123', newPin: '654321' })
        .expect(403);
    });
  });
});
