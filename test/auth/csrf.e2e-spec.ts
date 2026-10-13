import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createStore,
  createTestApp,
  createUser,
  CSRF_HEADER,
  resetState,
  session,
  sessionCookie,
  TEST_PIN,
} from '../helpers';

// The second CSRF layer: a non-GET session request needs the custom header.
// SameSite=Lax is the first layer; this one holds even if a cookie gets through.
describe('CSRF header (e2e)', () => {
  let app: INestApplication;
  let userToken: string;
  let storeToken: string;
  let storeKey: string;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(app);
    ({ token: userToken } = await createUser(app));
    const store = await createStore(app, {
      webhookUrl: 'https://shop.example.com/hooks',
    });
    storeToken = store.token;
    storeKey = store.secretKey;
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const cookieOnly = (token: string) => ({ Cookie: sessionCookie(token) });

  describe('a session cookie without the header is refused (403)', () => {
    it('POST /account/topup, and nothing is credited', async () => {
      await http()
        .post('/account/topup')
        .set(cookieOnly(userToken))
        .set('Idempotency-Key', 'k1')
        .send({ amountCents: 1000, pin: TEST_PIN })
        .expect(403);

      const res = await http()
        .get('/account/balance')
        .set(cookieOnly(userToken))
        .expect(200);
      expect(res.body).toEqual({ balanceCents: 0 });
    });

    it('POST /payments/:id/approve', async () => {
      const created = await http()
        .post('/payments')
        .set('Authorization', `Bearer ${storeKey}`)
        .set('Idempotency-Key', 'p1')
        .send({
          amountCents: 1000,
          orderId: 'o1',
          returnUrl: 'https://shop.example.com/done',
        })
        .expect(201);

      await http()
        .post(`/payments/${(created.body as { id: string }).id}/approve`)
        .set(cookieOnly(userToken))
        .send({ pin: TEST_PIN })
        .expect(403);
    });

    it('PUT /store/webhook', async () => {
      await http()
        .put('/store/webhook')
        .set(cookieOnly(storeToken))
        .send({ url: 'https://attacker.example.com/hooks' })
        .expect(403);
    });

    it('POST /auth/logout, and the session stays alive', async () => {
      await http().post('/auth/logout').set(cookieOnly(userToken)).expect(403);
      await http()
        .get('/account/balance')
        .set(cookieOnly(userToken))
        .expect(200);
    });

    it.each([
      ['PATCH /profile/name', '/profile/name', { name: 'Mallory' }],
      [
        'PATCH /profile/pin',
        '/profile/pin',
        { currentPin: TEST_PIN, newPin: '654321' },
      ],
      [
        'PATCH /profile/pin/forgot',
        '/profile/pin/forgot',
        { password: 'secret123', newPin: '654321' },
      ],
    ])('%s', async (_, path, body) => {
      await http()
        .patch(path)
        .set(cookieOnly(userToken))
        .send(body)
        .expect(403);
    });

    it('an empty header value counts as missing', async () => {
      await http()
        .post('/auth/logout')
        .set({ Cookie: sessionCookie(userToken), [CSRF_HEADER]: '' })
        .expect(403);
    });
  });

  it('accepts the same requests with the header', async () => {
    await http().post('/auth/logout').set(session(userToken)).expect(204);
  });

  it('leaves GET routes alone', async () => {
    await http().get('/account/balance').set(cookieOnly(userToken)).expect(200);
  });

  it('still answers 401, not 403, when there is no valid session', async () => {
    await http().post('/auth/logout').expect(401);
    await http().post('/auth/logout').set(cookieOnly('garbage')).expect(401);
  });

  it('does not apply to API-key routes, which store servers call', async () => {
    await http()
      .post('/payments')
      .set('Authorization', `Bearer ${storeKey}`)
      .set('Idempotency-Key', 'p1')
      .send({
        amountCents: 1000,
        orderId: 'o1',
        returnUrl: 'https://shop.example.com/done',
      })
      .expect(201);
  });
});
