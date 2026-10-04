import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import { createStore, createTestApp, createUser, resetState } from '../helpers';

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
    it('creates a user and returns a session token', async () => {
      const res = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body.token).toEqual(expect.any(String));
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

    it('returns a working session token', async () => {
      const res = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' })
        .expect(201);

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${res.body.token}`)
        .expect(204);
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
    it('returns a session token, an API key and a signing secret', async () => {
      const res = await http()
        .post('/auth/signup-store')
        .send({ name: 'Shop', email: 'shop@test.com', password: 'secret123' })
        .expect(201);

      expect(res.body).toEqual({
        token: expect.any(String),
        secretKey: expect.any(String),
        signingSecret: expect.any(String),
      });
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

      expect(res.body.token).toEqual(expect.any(String));
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
      const { body } = await http()
        .post('/auth/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' });
      const auth = `Bearer ${body.token}`;

      await http().post('/auth/logout').set('Authorization', auth).expect(204);
      await http().post('/auth/logout').set('Authorization', auth).expect(401);
    });

    it('only kills that one session', async () => {
      const first = await createUser(app);
      const second = await http()
        .post('/auth/login-user')
        .send({ email: 'ali@test.com', password: 'secret123' });

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${first.token}`)
        .expect(204);
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${second.body.token}`)
        .expect(204);
    });

    it('works for store sessions too', async () => {
      const store = await createStore(app);
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${store.token}`)
        .expect(204);
    });

    it.each([
      ['no header', undefined],
      ['Basic scheme', 'Basic abc123'],
      ['garbage token', 'Bearer garbage'],
      ['empty bearer', 'Bearer '],
    ])('rejects %s (401)', async (_, header) => {
      const req = http().post('/auth/logout');
      if (header !== undefined) req.set('Authorization', header);
      await req.expect(401);
    });

    it('rejects a store API key used as a session token (401)', async () => {
      const store = await createStore(app);
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${store.secretKey}`)
        .expect(401);
    });
  });

  describe('session types', () => {
    it('rejects a user session on a store-only route (403)', async () => {
      const user = await createUser(app);
      await http()
        .put('/store/webhook')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ url: 'https://shop.example.com/hooks' })
        .expect(403);
    });
  });
});
