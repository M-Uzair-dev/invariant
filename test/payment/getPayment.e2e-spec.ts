import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
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

describe('Get payment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: TestStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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
  const createPayment = async (amountCents = 2500, owner = store) => {
    orderSeq += 1;
    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${owner.secretKey}`)
      .set('Idempotency-Key', `pay-key-${orderSeq}`)
      .send({
        amountCents,
        orderId: `order-${orderSeq}`,
        returnUrl: 'https://shop.example.com/return',
      })
      .expect(201);
    return res.body.id as string;
  };

  const getPayment = (
    paymentId: string,
    auth: string | null = store.secretKey,
  ) => {
    let req = request(app.getHttpServer()).get(`/payments/${paymentId}`);
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    return req.send();
  };

  // ---------- tests ----------

  describe('reading your own payment', () => {
    it('returns 200 with exactly the public fields, matching the DB', async () => {
      const paymentId = await createPayment(2500);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      const res = await getPayment(paymentId).expect(200);

      expect(res.body).toEqual({
        id: paymentId,
        orderId: row.orderId,
        status: 'PENDING',
        amountCents: 2500,
        returnUrl: 'https://shop.example.com/return',
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      });
    });

    it('returns amountCents as a JSON number, not a string (BigInt serialization)', async () => {
      const paymentId = await createPayment(123456);

      const res = await getPayment(paymentId).expect(200);

      expect(typeof res.body.amountCents).toBe('number');
      expect(res.body.amountCents).toBe(123456);
    });

    it('never exposes internal fields, even after a user has paid', async () => {
      const paymentId = await createPayment(1000);
      const user = await createUser(app);
      await request(app.getHttpServer())
        .post('/account/topup')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', 'topup-1')
        .send({ amountCents: 1000 })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payments/${paymentId}/approve`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);

      const res = await getPayment(paymentId).expect(200);

      for (const field of [
        'userId',
        'storeId',
        'requestHash',
        'idempotencyKey',
      ]) {
        expect(res.body).not.toHaveProperty(field);
      }
    });
  });

  describe('status reflects the payment lifecycle', () => {
    it('shows SUCCESS after the user approves', async () => {
      const paymentId = await createPayment(1000);
      const user = await createUser(app);
      await request(app.getHttpServer())
        .post('/account/topup')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', 'topup-1')
        .send({ amountCents: 1000 })
        .expect(201);

      expect((await getPayment(paymentId).expect(200)).body.status).toBe(
        'PENDING',
      );

      await request(app.getHttpServer())
        .post(`/payments/${paymentId}/approve`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);

      expect((await getPayment(paymentId).expect(200)).body.status).toBe(
        'SUCCESS',
      );
    });

    it('shows EXPIRED for an expired payment', async () => {
      const paymentId = await createPayment();
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await getPayment(paymentId).expect(200);

      expect(res.body.status).toBe('EXPIRED');
    });

    it('is read-only: reading does not change the payment', async () => {
      const paymentId = await createPayment();
      const before = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      await getPayment(paymentId).expect(200);
      await getPayment(paymentId).expect(200);

      const after = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(after).toEqual(before);
    });
  });

  describe('not found (404)', () => {
    it("returns 404 for another store's payment", async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: 'https://other.example.com/hooks',
      });
      const othersPayment = await createPayment(2500, other);

      await getPayment(othersPayment, store.secretKey).expect(404);
      // The owner can still read it, so the 404 is about scoping, not a missing row.
      await getPayment(othersPayment, other.secretKey).expect(200);
    });

    it("gives no way to tell another store's payment from a missing one", async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: 'https://other.example.com/hooks',
      });
      const othersPayment = await createPayment(2500, other);

      const foreign = await getPayment(othersPayment).expect(404);
      const missing = await getPayment(randomUUID()).expect(404);

      expect(foreign.body).toEqual(missing.body);
    });

    it('returns 404 for a well-formed UUID that does not exist', async () => {
      await getPayment(randomUUID()).expect(404);
    });
  });

  describe('bad input (400)', () => {
    it('rejects a malformed id', async () => {
      await getPayment('not-a-uuid').expect(400);
    });

    it('rejects an id that is almost a UUID', async () => {
      const paymentId = await createPayment();
      await getPayment(paymentId.slice(0, -1)).expect(400);
    });
  });

  describe('auth (401)', () => {
    it('rejects a request with no Authorization header', async () => {
      const paymentId = await createPayment();
      await getPayment(paymentId, null).expect(401);
    });

    it('rejects an unknown API key', async () => {
      const paymentId = await createPayment();
      await getPayment(paymentId, 'sk_not_a_real_key').expect(401);
    });

    it('rejects a non-Bearer Authorization header', async () => {
      const paymentId = await createPayment();
      await request(app.getHttpServer())
        .get(`/payments/${paymentId}`)
        .set('Authorization', store.secretKey)
        .expect(401);
    });

    it("rejects the store's own login session token (API key only)", async () => {
      const paymentId = await createPayment();
      await getPayment(paymentId, store.token).expect(401);
    });

    it('rejects a user session token', async () => {
      const paymentId = await createPayment();
      const user = await createUser(app);
      await getPayment(paymentId, user.token).expect(401);
    });

    it('checks auth before input: no key + malformed id is 401, not 400', async () => {
      await getPayment('not-a-uuid', null).expect(401);
    });
  });
});
