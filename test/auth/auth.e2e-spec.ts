import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState } from '../helpers';

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

  describe('POST /signup-user', () => {
    it('creates a user and returns a session token', async () => {
      const res = await http()
        .post('/signup-user')
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
      await http().post('/signup-user').send(body).expect(201);

      await http().post('/signup-user').send(body).expect(409);
    });

    it('treats emails case-insensitively', async () => {
      await http()
        .post('/signup-user')
        .send({ name: 'Ali', email: 'Ali@Test.com', password: 'secret123' })
        .expect(201);

      await http()
        .post('/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' })
        .expect(409);
    });
  });

  describe('POST /logout', () => {
    it('kills the session: the same token is rejected afterwards', async () => {
      const { body } = await http()
        .post('/signup-user')
        .send({ name: 'Ali', email: 'ali@test.com', password: 'secret123' });
      const auth = `Bearer ${body.token}`;

      await http().post('/logout').set('Authorization', auth).expect(204);
      await http().post('/logout').set('Authorization', auth).expect(401);
    });
  });
});
