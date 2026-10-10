import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookStatus } from '../../src/generated/prisma/enums';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import { createStore, createTestApp, resetState, TestStore } from '../helpers';

interface FailedWebhook {
  id: string;
  lastError: string | null;
  lastResponseStatus: number | null;
  lastTried: string | null;
  attempts: number;
  createdAt: string;
  paymentId: string;
  payment: { orderId: string; status: string };
}

interface FailedPage {
  webhooks: FailedWebhook[];
  nextCursor: string | null;
}

describe('List failed webhooks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: TestStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    store = await createStore(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- helpers ----------

  let seq = 0;
  // Inserts `count` EXPIRED payments for the store, each with one outbox row.
  // createdAt is spread one second apart so the expected order is known.
  const insertEvents = async (
    storeId: string,
    count: number,
    status: WebhookStatus = 'FAILED',
  ) => {
    const base = Date.now() - 1_000_000;
    const payments = Array.from({ length: count }, () => {
      seq += 1;
      return {
        id: randomUUID(),
        status: 'EXPIRED' as const,
        amountCents: 1000n,
        idempotencyKey: `key-${seq}`,
        returnUrl: 'https://shop.example.com/return',
        orderId: `order-${seq}`,
        requestHash: 'hash',
        storeId,
        expiresAt: new Date(),
      };
    });
    await prisma.payment.createMany({ data: payments });
    const events = payments.map((p, i) => ({
      id: randomUUID(),
      paymentId: p.id,
      status,
      attempts: status === 'FAILED' ? 34 : 0,
      lastError: status === 'FAILED' ? 'HTTP 500' : null,
      lastResponseStatus: status === 'FAILED' ? 500 : null,
      lastTried: status === 'FAILED' ? new Date() : null,
      deliveredAt: status === 'DELIVERED' ? new Date() : null,
      createdAt: new Date(base + i * 1000),
    }));
    await prisma.webhookEvent.createMany({ data: events });
    return events.map((e, i) => ({ ...e, orderId: payments[i].orderId }));
  };

  const list = (
    query: Record<string, string | number> = {},
    auth: string | null = store.secretKey,
  ) => {
    let req = request(app.getHttpServer()).get('/webhooks/failed').query(query);
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    return req.send();
  };

  const page = async (query: Record<string, string | number> = {}) =>
    (await list(query).expect(200)).body as FailedPage;

  // ---------- tests ----------

  describe('auth', () => {
    it('401 without an API key', async () => {
      await list({}, null).expect(401);
    });

    it('401 with a wrong API key', async () => {
      await list({}, 'sk_wrong').expect(401);
    });

    it('401 with a store session token instead of the API key', async () => {
      await list({}, store.token).expect(401);
    });
  });

  describe('contents', () => {
    it('returns an empty page when there are no failed events', async () => {
      expect(await page()).toEqual({ webhooks: [], nextCursor: null });
    });

    it('returns exactly the public fields for a failed event', async () => {
      const [event] = await insertEvents(store.storeId, 1);

      const body = await page();

      expect(body.nextCursor).toBeNull();
      expect(body.webhooks).toEqual([
        {
          id: event.id,
          lastError: 'HTTP 500',
          lastResponseStatus: 500,
          lastTried: event.lastTried!.toISOString(),
          attempts: 34,
          createdAt: event.createdAt.toISOString(),
          paymentId: event.paymentId,
          payment: { orderId: event.orderId, status: 'EXPIRED' },
        },
      ]);
    });

    it('lists only FAILED events, never PENDING or DELIVERED ones', async () => {
      const failed = await insertEvents(store.storeId, 2);
      await insertEvents(store.storeId, 2, 'PENDING');
      await insertEvents(store.storeId, 2, 'DELIVERED');

      const body = await page();

      expect(body.webhooks.map((w) => w.id).sort()).toEqual(
        failed.map((e) => e.id).sort(),
      );
    });

    it("never shows another store's failed events", async () => {
      const other = await createStore(app, { email: 'other@test.com' });
      const mine = await insertEvents(store.storeId, 3);
      const theirs = await insertEvents(other.storeId, 3);

      const body = await page();
      expect(body.webhooks.map((w) => w.id).sort()).toEqual(
        mine.map((e) => e.id).sort(),
      );

      const otherBody = (await list({}, other.secretKey).expect(200))
        .body as FailedPage;
      expect(otherBody.webhooks.map((w) => w.id).sort()).toEqual(
        theirs.map((e) => e.id).sort(),
      );
    });

    it("another store's event id as the cursor leaks none of its events", async () => {
      const other = await createStore(app, { email: 'other@test.com' });
      const theirs = await insertEvents(other.storeId, 3);
      await insertEvents(store.storeId, 3);

      const body = await page({ cursor: theirs[0].id });

      const theirIds = new Set<string>(theirs.map((e) => e.id));
      expect(body.webhooks.some((w) => theirIds.has(w.id))).toBe(false);
    });

    it('an unknown cursor returns an empty page, not an error', async () => {
      await insertEvents(store.storeId, 3);
      expect(await page({ cursor: randomUUID() })).toEqual({
        webhooks: [],
        nextCursor: null,
      });
    });
  });

  describe('pagination', () => {
    it('defaults to 20 per page, oldest first', async () => {
      const events = await insertEvents(store.storeId, 25);

      const body = await page();

      expect(body.webhooks.map((w) => w.id)).toEqual(
        events.slice(0, 20).map((e) => e.id),
      );
      expect(body.nextCursor).toBe(events[20].id);
    });

    it('exactly `take` events left gives no next cursor', async () => {
      await insertEvents(store.storeId, 5);
      const body = await page({ take: 5 });
      expect(body.webhooks).toHaveLength(5);
      expect(body.nextCursor).toBeNull();
    });

    it('walking 250 events returns each exactly once, in order', async () => {
      const events = await insertEvents(store.storeId, 250);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string | number> = { take: 100 };
        if (cursor) query.cursor = cursor;
        const body = await page(query);
        seen.push(...body.webhooks.map((w) => w.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(events.map((e) => e.id));
    });

    it('events with the same createdAt are still paged without gaps or repeats', async () => {
      const events = await insertEvents(store.storeId, 30);
      const sameTime = new Date(Date.now() - 5000);
      await prisma.webhookEvent.updateMany({
        where: { id: { in: events.map((e) => e.id) } },
        data: { createdAt: sameTime },
      });

      const first = await page({ take: 10 });
      const second = await page({ take: 10, cursor: first.nextCursor! });
      const third = await page({ take: 10, cursor: second.nextCursor! });

      const seen = [first, second, third].flatMap((p) =>
        p.webhooks.map((w) => w.id),
      );
      expect(third.nextCursor).toBeNull();
      expect(seen).toHaveLength(30);
      expect(new Set(seen)).toEqual(new Set(events.map((e) => e.id)));
    });

    it('an event replayed between pages does not break the cursor', async () => {
      const events = await insertEvents(store.storeId, 10);

      const first = await page({ take: 5 });
      // The cursor row stops being FAILED before page 2 is fetched.
      await prisma.webhookEvent.update({
        where: { id: first.nextCursor! },
        data: { status: 'PENDING', attempts: 0 },
      });
      const second = await page({ take: 5, cursor: first.nextCursor! });

      expect(second.webhooks.map((w) => w.id)).toEqual(
        events.slice(6, 10).map((e) => e.id),
      );
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('query validation', () => {
    it.each([
      ['take=0', { take: 0 }],
      ['take=101', { take: 101 }],
      ['take=-5', { take: -5 }],
      ['take=1.5', { take: '1.5' }],
      ['take=abc', { take: 'abc' }],
      ['a cursor that is not a UUID', { cursor: 'not-a-uuid' }],
      ['an unknown query param', { status: 'PENDING' }],
    ])('400 for %s', async (_label, query) => {
      await list(query).expect(400);
    });

    it('take=100 is accepted', async () => {
      await list({ take: 100 }).expect(200);
    });
  });
});
