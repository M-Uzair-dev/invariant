import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  createStore,
  createTestApp,
  createUser,
  resetState,
  TestStore,
} from '../helpers';

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: TestStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    store = await createStore(app, { webhookUrl: 'https://shop.example.com/hooks' });
  });

  afterAll(async () => {
    await app.close();
  });

  const body = {
    amountCents: 2500,
    orderId: 'order-1',
    returnUrl: 'https://shop.example.com/return',
  };

  const create = (
    payload: object = body,
    key: string | null = 'key-1',
    apiKey: string | null = store.secretKey,
  ) => {
    let req = request(app.getHttpServer()).post('/payments');
    if (apiKey !== null) req = req.set('Authorization', `Bearer ${apiKey}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(payload);
  };

  describe('happy path', () => {
    it('creates a pending payment and returns a checkout URL', async () => {
      const before = Date.now();
      const res = await create().expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        status: 'PENDING',
        amountCents: 2500,
        orderId: 'order-1',
        expiresAt: expect.any(String),
        checkoutUrl: `${process.env.PAYMENT_PAGE_URL}/${res.body.id}`,
      });
      const expirySeconds = Number(process.env.PAYMENTS_EXPIRY_SECONDS);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThanOrEqual(
        before + expirySeconds * 1000,
      );

      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.storeId).toBe(store.storeId);
      expect(row.userId).toBeNull();
      expect(row.amountCents).toBe(2500n);
    });

    it('lets two stores use the same idempotency key and orderId', async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: 'https://other.example.com/hooks',
      });
      const a = await create().expect(201);
      const b = await create(body, 'key-1', other.secretKey).expect(201);

      expect(a.body.id).not.toBe(b.body.id);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for the same key and body', async () => {
      const first = await create().expect(201);
      const second = await create().expect(201);

      expect(second.body).toEqual(first.body);
      expect(await prisma.payment.count()).toBe(1);
    });

    it('rejects the same key with a different body (422)', async () => {
      await create().expect(201);
      await create({ ...body, amountCents: 9999 }).expect(422);

      expect(await prisma.payment.count()).toBe(1);
    });

    it('rejects a new key for an orderId that already has an active payment (409)', async () => {
      await create().expect(201);
      await create(body, 'key-2').expect(409);

      expect(await prisma.payment.count()).toBe(1);
    });

    it('allows a new payment for an orderId whose previous payment expired', async () => {
      const first = await create().expect(201);
      await prisma.payment.update({
        where: { id: first.body.id },
        data: { status: 'EXPIRED' },
      });

      await create(body, 'key-2').expect(201);
    });

    it('concurrent requests with the same key create exactly one payment', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => create()),
      );

      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.payment.count()).toBe(1);
    });

    it('concurrent requests with different keys for one orderId create exactly one payment', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => create(body, `key-${i}`)),
      );
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([201, ...Array(9).fill(409)]);
      expect(await prisma.payment.count()).toBe(1);
    });
  });

  describe('validation', () => {
    it('requires the Idempotency-Key header (400)', async () => {
      await create(body, null).expect(400);
    });

    it('rejects an Idempotency-Key over 255 characters (400)', async () => {
      await create(body, 'k'.repeat(256)).expect(400);
    });

    it('refuses stores without a webhook URL (400)', async () => {
      const noHook = await createStore(app, { email: 'nohook@test.com' });
      await create(body, 'key-1', noHook.secretKey).expect(400);

      expect(await prisma.payment.count()).toBe(0);
    });

    it.each([
      ['zero amount', { ...body, amountCents: 0 }],
      ['negative amount', { ...body, amountCents: -100 }],
      ['fractional amount', { ...body, amountCents: 10.5 }],
      ['amount as string', { ...body, amountCents: '2500' }],
      ['amount over the max', { ...body, amountCents: 100_000_001 }],
      ['empty orderId', { ...body, orderId: '' }],
      ['http returnUrl', { ...body, returnUrl: 'http://shop.example.com/r' }],
      ['unknown field', { ...body, storeId: 'someone-else' }],
    ])('rejects %s (400)', async (_, payload) => {
      await create(payload).expect(400);
      expect(await prisma.payment.count()).toBe(0);
    });
  });

  describe('API key guard', () => {
    it('rejects a missing API key (401)', async () => {
      await create(body, 'key-1', null).expect(401);
    });

    it('rejects a wrong API key (401)', async () => {
      await create(body, 'key-1', 'not-a-real-key').expect(401);
    });

    it('rejects a non-Bearer scheme (401)', async () => {
      await request(app.getHttpServer())
        .post('/payments')
        .set('Authorization', `Basic ${store.secretKey}`)
        .set('Idempotency-Key', 'key-1')
        .send(body)
        .expect(401);
    });

    it('rejects a store session token used as an API key (401)', async () => {
      await create(body, 'key-1', store.token).expect(401);
    });

    it('rejects a user session token used as an API key (401)', async () => {
      const user = await createUser(app);
      await create(body, 'key-1', user.token).expect(401);
    });
  });
});
