import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { RateLimitService } from '../../src/utils/rate-limit/rate-limit.service';
import {
  createTestApp,
  createUser,
  resetState,
  session,
  TEST_PIN,
} from '../helpers';

const GLOBAL_MAX = 20;
const AUTH_MAX = 3;

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  const saved = { ...process.env };

  beforeAll(async () => {
    // The guards read these when the app is built; .env.test sets them very high.
    process.env.RATE_LIMIT_GLOBAL_MAX = String(GLOBAL_MAX);
    process.env.RATE_LIMIT_AUTH_MAX = String(AUTH_MAX);
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  afterAll(async () => {
    await app.close();
    process.env.RATE_LIMIT_GLOBAL_MAX = saved.RATE_LIMIT_GLOBAL_MAX;
    process.env.RATE_LIMIT_AUTH_MAX = saved.RATE_LIMIT_AUTH_MAX;
    process.env.RATE_LIMIT_WINDOW_MS = saved.RATE_LIMIT_WINDOW_MS;
  });

  const http = () => request(app.getHttpServer());
  // Only the counters: the session keys live in the same Redis.
  const clearCounters = async () => {
    const redis = app.get<Redis>('REDIS_CLIENT');
    const keys = await redis.keys('rate:*');
    if (keys.length) await redis.del(...keys);
  };
  const login = (password: string) =>
    http().post('/auth/login-user').send({ email: 'ali@test.com', password });

  describe('auth limit', () => {
    it('blocks login after the limit, even with the right password', async () => {
      await createUser(app);
      await clearCounters();

      for (let i = 0; i < AUTH_MAX; i++) {
        await login('wrong-password').expect(401);
      }
      const res = await login('secret123').expect(429);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('counts rejected requests, so hammering keeps you blocked', async () => {
      for (let i = 0; i < AUTH_MAX; i++) await login('x').expect(401);
      for (let i = 0; i < 5; i++) await login('x').expect(429);
    });

    it('counts before validation (a malformed body still uses an attempt)', async () => {
      for (let i = 0; i < AUTH_MAX; i++) {
        await http().post('/auth/login-user').send({}).expect(400);
      }
      await http().post('/auth/login-user').send({}).expect(429);
    });

    it('is per route: exhausting user login leaves store login open', async () => {
      for (let i = 0; i < AUTH_MAX; i++) await login('x').expect(401);
      await login('x').expect(429);
      await http()
        .post('/auth/login-store')
        .send({ email: 'shop@test.com', password: 'x' })
        .expect(401);
    });

    it('covers both signups', async () => {
      for (let i = 0; i < AUTH_MAX; i++) {
        await http().post('/auth/signup-user').send({}).expect(400);
        await http().post('/auth/signup-store').send({}).expect(400);
      }
      await http().post('/auth/signup-user').send({}).expect(429);
      await http().post('/auth/signup-store').send({}).expect(429);
    });

    it('covers PIN reset with the password', async () => {
      const { token } = await createUser(app);
      await clearCounters();

      for (let i = 0; i < AUTH_MAX; i++) {
        await http()
          .patch('/profile/pin/forgot')
          .set(session(token))
          .send({ password: 'wrong-password', newPin: '654321' })
          .expect(400);
      }
      await http()
        .patch('/profile/pin/forgot')
        .set(session(token))
        .send({ password: 'secret123', newPin: '654321' })
        .expect(429);
    });

    it('does not apply to other routes', async () => {
      const { token } = await createUser(app);
      await clearCounters();
      for (let i = 0; i < AUTH_MAX + 2; i++) {
        await http().get('/account/balance').set(session(token)).expect(200);
      }
    });

    it('fails closed when Redis cannot answer (503)', async () => {
      await createUser(app);
      const spy = vi
        .spyOn(app.get(RateLimitService), 'hit')
        .mockRejectedValue(new Error('redis down'));
      onTestFinished(() => spy.mockRestore());

      await login('secret123').expect(503);
    });
  });

  describe('global limit', () => {
    it('blocks any route after the limit', async () => {
      const { token } = await createUser(app);
      await clearCounters();

      for (let i = 0; i < GLOBAL_MAX; i++) {
        await http().get('/account/balance').set(session(token)).expect(200);
      }
      await http().get('/account/balance').set(session(token)).expect(429);
      await http()
        .post('/account/topup')
        .set(session(token))
        .set('Idempotency-Key', 'k1')
        .send({ amountCents: 100, pin: TEST_PIN })
        .expect(429);
    });

    it('applies to unauthenticated requests too', async () => {
      for (let i = 0; i < GLOBAL_MAX; i++) {
        await http().get('/payments/not-a-uuid').expect(401);
      }
      await http().get('/payments/not-a-uuid').expect(429);
    });

    it('fails open when Redis cannot answer', async () => {
      const { token } = await createUser(app);
      const spy = vi
        .spyOn(app.get(RateLimitService), 'hit')
        .mockRejectedValue(new Error('redis down'));
      onTestFinished(() => spy.mockRestore());

      await http().get('/account/balance').set(session(token)).expect(200);
    });
  });

  describe('sliding window', () => {
    it('allows the limit, refuses the next, and frees up as entries age out', async () => {
      const limiter = app.get(RateLimitService);
      expect(await limiter.hit('t', 2, 300)).toBe(true);
      expect(await limiter.hit('t', 2, 300)).toBe(true);
      expect(await limiter.hit('t', 2, 300)).toBe(false);

      await new Promise((r) => setTimeout(r, 350));
      expect(await limiter.hit('t', 2, 300)).toBe(true);
    });

    it('lets exactly the limit through when requests arrive at once', async () => {
      const limiter = app.get(RateLimitService);
      const results = await Promise.all(
        Array.from({ length: 50 }, () => limiter.hit('burst', 10, 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
    });

    it('expires the key once the window passes', async () => {
      await app.get(RateLimitService).hit('ttl', 5, 60_000);
      const ttl = await app.get<Redis>('REDIS_CLIENT').pttl('rate:ttl');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });
});
