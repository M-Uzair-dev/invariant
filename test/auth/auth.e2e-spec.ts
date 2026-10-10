import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import {
  createStore,
  createTestApp,
  createUser,
  resetState,
  SESSION_COOKIE,
  sessionCookie,
  sessionTokenFrom,
} from '../helpers';

const setCookies = (res: request.Response): string[] =>
  (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

const sessionSetCookie = (res: request.Response) => {
  const c = setCookies(res).find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (!c) throw new Error('no session cookie set');
  return c;
};

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('POST /auth/signup-user', () => {
    it('creates a user and sets a session cookie, with no token in the body', async () => {
      const res = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body).toEqual({ success: true });
      const token = sessionTokenFrom(res);
      expect(token.length).toBeGreaterThan(20);
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('sets HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', async () => {
      const res = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      const attrs = sessionSetCookie(res)
        .split(';')
        .slice(1)
        .map((a) => a.trim().toLowerCase());
      expect(attrs).toContain('httponly');
      expect(attrs).toContain('secure');
      expect(attrs).toContain('samesite=lax');
      expect(attrs).toContain('path=/');
      expect(attrs.some((a) => a.startsWith('domain='))).toBe(false);
    });

    it('caps the cookie lifetime at SESSION_MAX_LIFETIME_SECONDS', async () => {
      const res = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      const maxAge = sessionSetCookie(res)
        .split(';')
        .map((a) => a.trim())
        .find((a) => a.toLowerCase().startsWith('max-age='));
      expect(maxAge).toBe(`Max-Age=${process.env.SESSION_MAX_LIFETIME_SECONDS}`);
    });

    it('sets no cookie when signup fails', async () => {
      await createUser(app);
      const res = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(409);

      expect(setCookies(res)).toEqual([]);
    });

    it('rejects a duplicate email with 409', async () => {
      const body = {
        name: 'Ali',
        email: 'ali@test.com',
        password: 'secret123',
      };
      await http().post('/auth/signup-user').send(body).expect(201);

      await http().post('/auth/signup-user').send(body).expect(409);
    });

    it('treats emails case-insensitively', async () => {
      await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'Ali@Test.com', password: 'secret123' })
        .expect(201);

      await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(409);
    });

    it.each([
      ['invalid email', { name: 'Ali', email: 'not-an-email', password: 'secret123' }],
      ['short password', { name: 'Ali', email: 'ali@test.com', password: '12345' }],
      ['missing name', { email: 'ali@test.com', password: 'secret123' }],
      ['unknown extra field', { name: 'Ali', email: 'ali@test.com', password: 'secret123', role: 'admin' }],
    ])('rejects %s (400)', async (_, body) => {
      await http().post('/auth/signup-user').send(body).expect(400);
    });
  });

  describe('POST /auth/login-user', () => {
    beforeEach(async () => {
      await createUser(app, 'ali@test.com');
    });

    it('sets a working session cookie, with no token in the body', async () => {
      const res = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body).toEqual({ success: true });
      await http()
        .get('/account/balance')
        .set('Cookie', sessionCookie(sessionTokenFrom(res)))
        .expect(200);
    });

    it('issues a new session on every login', async () => {
      const a = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' })
        .expect(201);
      const b = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      expect(sessionTokenFrom(a)).not.toBe(sessionTokenFrom(b));
    });

    it('accepts the email in any case', async () => {
      await http()
        .post('/auth/login-user')
        .send({ email: 'ALI@test.com', password: 'secret123' })
        .expect(201);
    });

    it('gives the same 401 for a wrong password and an unknown email', async () => {
      const wrongPassword = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'wrong-password' })
        .expect(401);
      const unknownEmail = await http()
        .post('/auth/login-user')
        .send({ email: 'nobody@test.com', password: 'secret123' })
        .expect(401);

      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(setCookies(wrongPassword)).toEqual([]);
      expect(setCookies(unknownEmail)).toEqual([]);
    });

    it('rejects an invalid email (400)', async () => {
      await http()
        .post('/auth/login-user')
        .send({ email: 'nope', password: 'secret123' })
        .expect(400);
    });

    it('does not let a user log in as a store', async () => {
      await http()
        .post('/auth/login-store')
        .send({ email: 'ali@test.com', password: 'secret123' })
        .expect(401);
    });
  });

  describe('POST /auth/signup-store', () => {
    it('returns only the API key and signing secret, and sets a session cookie', async () => {
      const res = await http()
        .post('/auth/signup-store')
        .send({ name: 'Shop', email: 'shop@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body).toEqual({
        secretKey: expect.any(String),
        signingSecret: expect.any(String),
      });
      await http()
        .get('/account/balance')
        .set('Cookie', sessionCookie(sessionTokenFrom(res)))
        .expect(200);
    });

    it('stores only sha256(secretKey), never the raw key', async () => {
      const store = await createStore(app);
      const row = await app
        .get(PrismaService)
        .store.findUniqueOrThrow({ where: { id: store.storeId } });

      expect(row.secretKeyHash).toBe(
        createHash('sha256').update(store.secretKey).digest('hex'),
      );
      expect(JSON.stringify(row)).not.toContain(store.secretKey);
    });

    it('rejects a duplicate store email with 409', async () => {
      await createStore(app);
      await http()
        .post('/auth/signup-store')
        .send({ name: 'Shop', email: 'SHOP@test.com', password: 'secret123' })
        .expect(409);
    });
  });

  describe('POST /auth/login-store', () => {
    beforeEach(async () => {
      await createStore(app, { email: 'shop@test.com' });
    });

    it('logs in with the right password', async () => {
      const res = await http()
        .post('/auth/login-store')
        .send({ email: 'shop@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body).toEqual({ success: true });
      await http()
        .get('/account/balance')
        .set('Cookie', sessionCookie(sessionTokenFrom(res)))
        .expect(200);
    });

    it('gives the same 401 for a wrong password and an unknown email', async () => {
      const wrongPassword = await http()
        .post('/auth/login-store')
        .send({ email: 'shop@test.com', password: 'wrong-password' })
        .expect(401);
      const unknownEmail = await http()
        .post('/auth/login-store')
        .send({ email: 'nobody@test.com', password: 'secret123' })
        .expect(401);

      expect(wrongPassword.body).toEqual(unknownEmail.body);
    });
  });

  describe('POST /auth/logout', () => {
    it('kills the session: the same token is rejected afterwards', async () => {
      const { token } = await createUser(app);
      const cookie = sessionCookie(token);

      await http().post('/auth/logout').set('Cookie', cookie).expect(204);
      await http().post('/auth/logout').set('Cookie', cookie).expect(401);
      await http().get('/account/balance').set('Cookie', cookie).expect(401);
    });

    it('tells the browser to delete the cookie, with matching attributes', async () => {
      const { token } = await createUser(app);
      const res = await http()
        .post('/auth/logout')
        .set('Cookie', sessionCookie(token))
        .expect(204);

      const [nameValue, ...rest] = sessionSetCookie(res)
        .split(';')
        .map((a) => a.trim());
      const attrs = rest.map((a) => a.toLowerCase());
      expect(nameValue).toBe(`${SESSION_COOKIE}=`);
      const expires = rest.find((a) => a.toLowerCase().startsWith('expires='));
      expect(expires).toBeDefined();
      expect(
        new Date(expires!.slice('expires='.length)).getTime(),
      ).toBeLessThan(Date.now());
      expect(attrs).toContain('path=/');
      expect(attrs).toContain('secure');
      expect(attrs).toContain('httponly');
      expect(attrs).toContain('samesite=lax');
    });

    it('only kills that one session', async () => {
      const first = await createUser(app);
      const second = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' });

      await http()
        .post('/auth/logout')
        .set('Cookie', sessionCookie(first.token))
        .expect(204);
      await http()
        .post('/auth/logout')
        .set('Cookie', sessionCookie(sessionTokenFrom(second)))
        .expect(204);
    });

    it('works for store sessions too', async () => {
      const store = await createStore(app);
      await http()
        .post('/auth/logout')
        .set('Cookie', sessionCookie(store.token))
        .expect(204);
    });

    it.each([
      ['no cookie', undefined],
      ['garbage token', sessionCookie('garbage')],
      ['empty value', `${SESSION_COOKIE}=`],
      ['some other cookie only', 'theme=dark'],
      ['a JSON cookie (j: prefix)', `${SESSION_COOKIE}=j:${encodeURIComponent('{"a":1}')}`],
    ])('rejects %s (401)', async (_, cookie) => {
      const req = http().post('/auth/logout');
      if (cookie !== undefined) req.set('Cookie', cookie);
      await req.expect(401);
    });

    it('rejects a store API key used as a session cookie (401)', async () => {
      const store = await createStore(app);
      await http()
        .post('/auth/logout')
        .set('Cookie', sessionCookie(store.secretKey))
        .expect(401);
    });
  });

  describe('cookie-only sessions', () => {
    it('ignores a valid session token sent as a Bearer header (401)', async () => {
      const { token } = await createUser(app);
      await http()
        .get('/account/balance')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('ignores a valid token under the wrong cookie name (401)', async () => {
      const { token } = await createUser(app);
      await http()
        .get('/account/balance')
        .set('Cookie', `session=${token}`)
        .expect(401);
    });

    it('finds the session cookie among other cookies', async () => {
      const { token } = await createUser(app);
      await http()
        .get('/account/balance')
        .set('Cookie', `theme=dark; ${sessionCookie(token)}; lang=en`)
        .expect(200);
    });

    it('does not accept a session cookie on an API-key route (401)', async () => {
      const store = await createStore(app);
      await http()
        .post('/payments')
        .set('Cookie', sessionCookie(store.token))
        .set('Idempotency-Key', 'k1')
        .send({
          amountCents: 1000,
          orderId: 'o1',
          returnUrl: 'https://shop.example.com/done',
        })
        .expect(401);
      expect(await app.get(PrismaService).payment.count()).toBe(0);
    });
  });

  describe('session types', () => {
    it('rejects a user session on a store-only route (403)', async () => {
      const user = await createUser(app);
      await http()
        .put('/store/webhook')
        .set('Cookie', sessionCookie(user.token))
        .send({ url: 'https://shop.example.com/hooks' })
        .expect(403);
    });
  });
});
