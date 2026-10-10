import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookStatus } from '../../src/generated/prisma/enums';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import { WebhookWorker } from '../../src/webhook/webhook.worker';
import {
  assertPaymentInvariants,
  createStore,
  createTestApp,
  resetState,
  TestStore,
} from '../helpers';

// A local store endpoint that records requests and answers with `status`.
class Receiver {
  received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  status = 200;
  private server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      this.received.push({ headers: req.headers, body });
      res.writeHead(this.status).end();
    });
  });

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
  }
  url() {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hooks`;
  }
  reset() {
    this.received = [];
    this.status = 200;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const MAX_ATTEMPTS = 34;

describe('Replay a failed webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: WebhookWorker;
  let receiver: Receiver;
  let store: TestStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    worker = app.get(WebhookWorker);
    receiver = new Receiver();
    await receiver.start();
  });

  beforeEach(async () => {
    await resetState(app);
    receiver.reset();
    store = await createStore(app, { webhookUrl: receiver.url() });
  });

  afterAll(async () => {
    await receiver.stop();
    await app.close();
  });

  // ---------- helpers ----------

  let seq = 0;
  // An EXPIRED payment with one outbox row in the given state. FAILED rows look
  // like the worker's dead letter left them.
  const insertEvent = async (
    status: WebhookStatus = 'FAILED',
    storeId = store.storeId,
  ) => {
    seq += 1;
    const payment = await prisma.payment.create({
      data: {
        status: 'EXPIRED',
        amountCents: 1500n,
        idempotencyKey: `key-${seq}`,
        requestHash: `hash-${seq}`,
        returnUrl: 'https://shop.example.com/return',
        orderId: `order-${seq}`,
        storeId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const failed = status === 'FAILED';
    const event = await prisma.webhookEvent.create({
      data: {
        paymentId: payment.id,
        status,
        attempts: failed ? MAX_ATTEMPTS : 0,
        lastError: failed ? 'HTTP 500' : null,
        lastResponseStatus: failed ? 500 : null,
        lastTried: failed ? new Date() : null,
        deliveredAt: status === 'DELIVERED' ? new Date() : null,
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { eventId: event.id, paymentId: payment.id };
  };

  const replay = (id: string, auth: string | null = store.secretKey) => {
    let req = request(app.getHttpServer()).post(`/webhooks/${id}/replay`);
    if (auth !== null) req = req.set('Authorization', `Bearer ${auth}`);
    return req.send();
  };

  const eventRow = (id: string) =>
    prisma.webhookEvent.findUniqueOrThrow({ where: { id } });

  const failedIds = async (secretKey = store.secretKey) => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/failed')
      .set('Authorization', `Bearer ${secretKey}`)
      .expect(200);
    return (res.body as { webhooks: { id: string }[] }).webhooks.map(
      (w) => w.id,
    );
  };

  // ---------- tests ----------

  describe('auth and validation', () => {
    it('401 without an API key', async () => {
      const { eventId } = await insertEvent();
      await replay(eventId, null).expect(401);
    });

    it('401 with a wrong API key', async () => {
      const { eventId } = await insertEvent();
      await replay(eventId, 'sk_wrong').expect(401);
    });

    it('401 with a store session token instead of the API key', async () => {
      const { eventId } = await insertEvent();
      await replay(eventId, store.token).expect(401);
      expect((await eventRow(eventId)).status).toBe('FAILED');
    });

    it('400 for an id that is not a UUID', async () => {
      await replay('not-a-uuid').expect(400);
    });
  });

  describe('resetting the row', () => {
    it('202 and the same row goes back to PENDING, due now, with a clean slate', async () => {
      const { eventId, paymentId } = await insertEvent();
      const before = new Date();

      const res = await replay(eventId).expect(202);

      expect(res.body).toEqual({ id: eventId, status: 'PENDING' });
      const row = await eventRow(eventId);
      expect(row).toMatchObject({
        id: eventId,
        paymentId,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        lastResponseStatus: null,
        lastTried: null,
        lockedUntil: null,
        deliveredAt: null,
      });
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
      expect(await prisma.webhookEvent.count()).toBe(1);
    });

    it('the replayed event disappears from the failed list', async () => {
      const a = await insertEvent();
      const b = await insertEvent();

      await replay(a.eventId).expect(202);

      expect(await failedIds()).toEqual([b.eventId]);
    });

    it('replaying one event leaves the other failed events alone', async () => {
      const a = await insertEvent();
      const b = await insertEvent();

      await replay(a.eventId).expect(202);

      const other = await eventRow(b.eventId);
      expect(other.status).toBe('FAILED');
      expect(other.attempts).toBe(MAX_ATTEMPTS);
    });

    it('does not touch the payment or the store alert columns', async () => {
      const { eventId, paymentId } = await insertEvent();
      const owedAt = new Date(Date.now() - 60_000);
      await prisma.store.update({
        where: { id: store.storeId },
        data: { webhookAlertOwedAt: owedAt },
      });
      const paymentBefore = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      await replay(eventId).expect(202);

      expect(
        await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
      ).toEqual(paymentBefore);
      const s = await prisma.store.findUniqueOrThrow({
        where: { id: store.storeId },
      });
      expect(s.webhookAlertOwedAt).toEqual(owedAt);
      expect(s.webhookAlertSentAt).toBeNull();
    });
  });

  describe('events that cannot be replayed', () => {
    it('409 when the event was already replayed', async () => {
      const { eventId } = await insertEvent();
      await replay(eventId).expect(202);

      await replay(eventId).expect(409);
      expect((await eventRow(eventId)).status).toBe('PENDING');
    });

    it('409 for a DELIVERED event, which stays delivered', async () => {
      const { eventId } = await insertEvent('DELIVERED');

      await replay(eventId).expect(409);

      const row = await eventRow(eventId);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).not.toBeNull();
    });

    it('409 for a PENDING event, whose retry state is kept', async () => {
      const { eventId } = await insertEvent('PENDING');
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { attempts: 5, lastError: 'HTTP 503' },
      });

      await replay(eventId).expect(409);

      const row = await eventRow(eventId);
      expect(row.attempts).toBe(5);
      expect(row.lastError).toBe('HTTP 503');
    });

    it('404 for an unknown id', async () => {
      await replay(randomUUID()).expect(404);
    });

    it("404 for another store's event, with the same body as an unknown id, and it stays FAILED", async () => {
      const other = await createStore(app, { email: 'other@test.com' });
      const { eventId } = await insertEvent('FAILED', other.storeId);

      const theirs = await replay(eventId).expect(404);
      const missing = await replay(randomUUID()).expect(404);

      expect(theirs.body).toEqual(missing.body);
      const row = await eventRow(eventId);
      expect(row.status).toBe('FAILED');
      expect(row.attempts).toBe(MAX_ATTEMPTS);
      expect(await failedIds(other.secretKey)).toEqual([eventId]);
    });

    it("404 for another store's DELIVERED event too (no 409 that would confirm it exists)", async () => {
      const other = await createStore(app, { email: 'other@test.com' });
      const { eventId } = await insertEvent('DELIVERED', other.storeId);

      await replay(eventId).expect(404);
    });
  });

  describe('concurrency', () => {
    it('10 simultaneous replays of one event: exactly one 202, the rest 409', async () => {
      const { eventId } = await insertEvent();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => replay(eventId)),
      );

      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 202)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(9);
      const row = await eventRow(eventId);
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
    });
  });

  describe('delivery after replay', () => {
    it('the worker delivers the replayed event with the same event id', async () => {
      const { eventId, paymentId } = await insertEvent();

      await worker.sendRequests();
      expect(receiver.received).toHaveLength(0); // FAILED is never picked up

      await replay(eventId).expect(202);
      await worker.sendRequests();

      expect(receiver.received).toHaveLength(1);
      const [sent] = receiver.received;
      expect(sent.headers['invariant-event-id']).toBe(eventId);
      const body = JSON.parse(sent.body) as {
        id: string;
        type: string;
        data: { paymentId: string };
      };
      expect(body.id).toBe(eventId);
      expect(body.type).toBe('payment.expired');
      expect(body.data.paymentId).toBe(paymentId);

      const row = await eventRow(eventId);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).not.toBeNull();
      await assertPaymentInvariants(app);
    });

    it('a delivered replay can no longer be replayed', async () => {
      const { eventId } = await insertEvent();
      await replay(eventId).expect(202);
      await worker.sendRequests();

      await replay(eventId).expect(409);
      expect(receiver.received).toHaveLength(1);
    });

    it('a replayed event that keeps failing climbs back to the dead letter, then can be replayed again', async () => {
      const { eventId } = await insertEvent();
      receiver.status = 500;

      await replay(eventId).expect(202);
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await worker.sendRequests();
        const row = await eventRow(eventId);
        if (row.status === 'FAILED') break;
        expect(row.attempts).toBe(i + 1);
        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
      }

      const dead = await eventRow(eventId);
      expect(dead.status).toBe('FAILED');
      expect(dead.attempts).toBe(MAX_ATTEMPTS);
      expect(dead.lastResponseStatus).toBe(500);
      expect(receiver.received).toHaveLength(MAX_ATTEMPTS);
      expect(await failedIds()).toEqual([eventId]);

      receiver.status = 200;
      await replay(eventId).expect(202);
      await worker.sendRequests();
      expect((await eventRow(eventId)).status).toBe('DELIVERED');
      expect(
        new Set(receiver.received.map((r) => r.headers['invariant-event-id'])),
      ).toEqual(new Set([eventId]));
    });
  });
});
