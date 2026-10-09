import { createHmac } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import { WebhookWorker } from '../../src/webhook/webhook.worker';
import {
  assertLedgerInvariants,
  assertPaymentInvariants,
  createStore,
  createTestApp,
  createUser,
  resetState,
  TestStore,
} from '../helpers';

// ---------- a local store endpoint ----------

type Received = {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};
type Reply = { status: number; headers?: Record<string, string> } | 'hang';
type Handler = (req: Received) => Reply | Promise<Reply>;

// A real HTTP server on 127.0.0.1 that records every request. Tests swap
// `handler` to make the "store" succeed, fail, redirect, or never answer.
class Receiver {
  received: Received[] = [];
  handler: Handler = () => ({ status: 200 });
  private server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const entry = { path: req.url ?? '', headers: req.headers, body };
      this.received.push(entry);
      void Promise.resolve(this.handler(entry)).then((reply) => {
        if (reply === 'hang') return; // never answer: the worker's timeout must fire
        res.writeHead(reply.status, reply.headers).end();
      });
    });
  });

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
  }
  url(path = '/hooks') {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${path}`;
  }
  reset() {
    this.received = [];
    this.handler = () => ({ status: 200 });
    this.server.closeAllConnections(); // drop sockets a 'hang' test left open
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  bodies() {
    return this.received.map((r) => JSON.parse(r.body) as WebhookBody);
  }
}

type WebhookBody = {
  id: string;
  type: string;
  createdAt: string;
  data: {
    paymentId: string;
    orderId: string;
    status: string;
    amountCents: number;
  };
};

const MAX_ATTEMPTS = 34;

describe('Webhook delivery worker (e2e)', () => {
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
  // An EXPIRED payment with its outbox row, inserted directly (what the expiry
  // worker produces). `event` overrides the outbox row's columns.
  const insertExpiredEvent = async (
    event: Partial<{
      status: 'PENDING' | 'DELIVERED' | 'FAILED';
      attempts: number;
      nextAttemptAt: Date;
      lockedUntil: Date | null;
      deliveredAt: Date | null;
    }> = {},
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
    const row = await prisma.webhookEvent.create({
      data: { paymentId: payment.id, ...event },
    });
    return { eventId: row.id, paymentId: payment.id, orderId: payment.orderId };
  };

  const insertManyExpiredEvents = async (count: number) => {
    const past = new Date(Date.now() - 60_000);
    const payments = await prisma.payment.createManyAndReturn({
      data: Array.from({ length: count }, (_, i) => ({
        status: 'EXPIRED' as const,
        amountCents: 100n,
        idempotencyKey: `bulk-${i}`,
        requestHash: `bulk-hash-${i}`,
        returnUrl: 'https://shop.example.com/return',
        orderId: `bulk-order-${i}`,
        storeId: store.storeId,
        expiresAt: past,
      })),
      select: { id: true },
    });
    await prisma.webhookEvent.createMany({
      data: payments.map((p) => ({ paymentId: p.id })),
    });
  };

  // A real succeeded payment: created, funded and approved through the API.
  const createSucceededPayment = async () => {
    const http = request(app.getHttpServer());
    const created = await http
      .post('/payments')
      .set('Authorization', `Bearer ${store.secretKey}`)
      .set('Idempotency-Key', 'pay-ok')
      .send({
        amountCents: 4200,
        orderId: 'order-ok',
        returnUrl: 'https://shop.example.com/return',
      })
      .expect(201);
    const { token } = await createUser(app);
    await http
      .post('/account/topup')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'topup-ok')
      .send({ amountCents: 10_000 })
      .expect(201);
    await http
      .post(`/payments/${(created.body as { id: string }).id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send()
      .expect(201);
    return (created.body as { id: string }).id;
  };

  const eventRow = (id: string) =>
    prisma.webhookEvent.findUniqueOrThrow({ where: { id } });

  const storeRow = (id = store.storeId) =>
    prisma.store.findUniqueOrThrow({
      where: { id },
      select: { webhookAlertOwedAt: true, webhookAlertSentAt: true },
    });

  // simulates time passing: the event is due again right now
  const makeDue = (id: string) =>
    prisma.webhookEvent.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

  const setStoreUrl = (url: string | null, id = store.storeId) =>
    prisma.store.update({ where: { id }, data: { webhookUrl: url } });

  const verifySignature = (r: Received, secret: string) => {
    const header = String(r.headers['invariant-signature']);
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    expect(match).not.toBeNull();
    const [, t, v1] = match!;
    const expected = createHmac('sha256', secret)
      .update(`${t}.${r.body}`)
      .digest('hex');
    expect(v1).toBe(expected);
    // the timestamp is the send time, so stores can reject old replays
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(30);
  };

  const assertAllInvariants = async () => {
    await assertLedgerInvariants(app);
    await assertPaymentInvariants(app);
  };

  // ---------- wiring ----------

  describe('wiring', () => {
    it('is registered, and the timer is off when WEBHOOK_WORKER_INTERVAL_MS=0', () => {
      expect(worker).toBeInstanceOf(WebhookWorker);
      expect(app.get(SchedulerRegistry).getIntervals()).not.toContain(
        'webhook-delivery',
      );
    });

    it('does nothing on an empty table', async () => {
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(0);
    });
  });

  // ---------- happy path ----------

  describe('delivering an event', () => {
    it('POSTs a signed payment.expired event and marks the row DELIVERED', async () => {
      const { eventId, paymentId, orderId } = await insertExpiredEvent();
      const before = await eventRow(eventId);

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(1);
      const [req] = receiver.received;
      expect(req.path).toBe('/hooks');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['invariant-event-id']).toBe(eventId);
      verifySignature(req, store.signingSecret);
      expect(JSON.parse(req.body)).toEqual({
        id: eventId,
        type: 'payment.expired',
        createdAt: before.createdAt.toISOString(),
        data: { paymentId, orderId, status: 'EXPIRED', amountCents: 1500 },
      });

      const row = await eventRow(eventId);
      expect(row).toMatchObject({
        status: 'DELIVERED',
        attempts: 0,
        lockedUntil: null,
        lastError: null,
        lastResponseStatus: 200,
      });
      expect(row.deliveredAt).toBeInstanceOf(Date);
      expect(row.lastTried).toEqual(row.deliveredAt);
      await assertAllInvariants();
    });

    it('sends payment.succeeded for a payment approved through the API', async () => {
      const paymentId = await createSucceededPayment();

      await worker.sendRequests();

      const [body] = receiver.bodies();
      expect(body.type).toBe('payment.succeeded');
      expect(body.data).toEqual({
        paymentId,
        orderId: 'order-ok',
        status: 'SUCCESS',
        amountCents: 4200,
      });
      const row = await prisma.webhookEvent.findUniqueOrThrow({
        where: { paymentId },
      });
      expect(row.status).toBe('DELIVERED');
      await assertAllInvariants();
    });

    it('treats any 2xx as delivered and records the status', async () => {
      receiver.handler = () => ({ status: 204 });
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      expect(await eventRow(eventId)).toMatchObject({
        status: 'DELIVERED',
        lastResponseStatus: 204,
      });
    });

    it('never sends a delivered event again', async () => {
      const { eventId } = await insertExpiredEvent();
      await worker.sendRequests();
      await makeDue(eventId); // even if it somehow looked due

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(1);
    });

    it('signs each store with its own secret and sends to its own URL', async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: receiver.url('/other'),
      });
      const mine = await insertExpiredEvent();
      const theirs = await insertExpiredEvent({}, other.storeId);

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(2);
      const toMe = receiver.received.find((r) => r.path === '/hooks')!;
      const toThem = receiver.received.find((r) => r.path === '/other')!;
      expect((JSON.parse(toMe.body) as WebhookBody).id).toBe(mine.eventId);
      expect((JSON.parse(toThem.body) as WebhookBody).id).toBe(theirs.eventId);
      verifySignature(toMe, store.signingSecret);
      verifySignature(toThem, other.signingSecret);
    });
  });

  // ---------- which rows are picked ----------

  describe('which events are picked up', () => {
    it('skips events that are not due yet', async () => {
      const { eventId } = await insertExpiredEvent({
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(0);
      expect((await eventRow(eventId)).status).toBe('PENDING');
    });

    it('skips events another worker holds an active lease on', async () => {
      const lease = new Date(Date.now() + 30_000);
      const { eventId } = await insertExpiredEvent({ lockedUntil: lease });
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(0);
      expect((await eventRow(eventId)).lockedUntil).toEqual(lease);
    });

    it('picks up an event whose lease expired: a worker crashed after claiming it', async () => {
      const { eventId } = await insertExpiredEvent({
        lockedUntil: new Date(Date.now() - 1000),
      });
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(1);
      expect((await eventRow(eventId)).status).toBe('DELIVERED');
    });

    it('skips DELIVERED and FAILED (dead-lettered) events', async () => {
      await insertExpiredEvent({
        status: 'DELIVERED',
        deliveredAt: new Date(),
      });
      await insertExpiredEvent({ status: 'FAILED', attempts: MAX_ATTEMPTS });
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(0);
    });

    it('drains a backlog of 250 in one tick (batches of 100), each sent once', async () => {
      await insertManyExpiredEvents(250);

      await worker.sendRequests();

      const ids = receiver.bodies().map((b) => b.id);
      expect(ids).toHaveLength(250);
      expect(new Set(ids).size).toBe(250);
      expect(
        await prisma.webhookEvent.count({ where: { status: 'DELIVERED' } }),
      ).toBe(250);
      await assertAllInvariants();
    });
  });

  // ---------- failures and backoff ----------

  describe('failed attempts', () => {
    it('records a non-2xx response and schedules a retry ~5 s out', async () => {
      receiver.handler = () => ({ status: 500 });
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      const row = await eventRow(eventId);
      expect(row).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lockedUntil: null,
        lastResponseStatus: 500,
        lastError: 'Store responded with 500',
        deliveredAt: null,
      });
      const delay = row.nextAttemptAt.getTime() - row.lastTried!.getTime();
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(6000);
    });

    it('does not retry before nextAttemptAt', async () => {
      receiver.handler = () => ({ status: 500 });
      await insertExpiredEvent();
      await worker.sendRequests();
      await worker.sendRequests();
      expect(receiver.received).toHaveLength(1);
    });

    it('treats 4xx as a failure too', async () => {
      receiver.handler = () => ({ status: 400 });
      const { eventId } = await insertExpiredEvent();
      await worker.sendRequests();
      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastResponseStatus: 400,
      });
    });

    it.each([
      [3, 40_000],
      [9, 2_560_000],
      [10, 3_600_000], // 5 s * 2^10 would be 85 min: capped at an hour
      [20, 3_600_000],
    ])(
      'backs off exponentially with jitter (attempts=%i → ~%i ms)',
      async (attempts, base) => {
        receiver.handler = () => ({ status: 503 });
        const { eventId } = await insertExpiredEvent({ attempts });

        await worker.sendRequests();

        const row = await eventRow(eventId);
        expect(row.attempts).toBe(attempts + 1);
        const delay = row.nextAttemptAt.getTime() - row.lastTried!.getTime();
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      },
    );

    it('counts a store with no webhook URL as a failed attempt, without sending', async () => {
      await setStoreUrl(null);
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(0);
      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'Store has no webhook URL',
        lastResponseStatus: null,
      });
    });

    it.each([
      ['https://10.0.0.1/hooks', 'Webhook URL must point to a public address.'],
      [
        'https://169.254.169.254/latest',
        'Webhook URL must point to a public address.',
      ],
      ['http://169.254.169.254/latest', 'Webhook URL must use https.'],
      ['http://localhost:9/hooks', 'Webhook URL must use https.'],
    ])(
      're-runs the SSRF check before sending: %s is refused',
      async (url, error) => {
        await setStoreUrl(url);
        const { eventId } = await insertExpiredEvent();

        await worker.sendRequests();

        expect(await eventRow(eventId)).toMatchObject({
          status: 'PENDING',
          attempts: 1,
          lastError: error,
        });
      },
    );

    it('does not follow redirects (a redirect could point inside the network)', async () => {
      receiver.handler = (r) =>
        r.path === '/hooks'
          ? { status: 302, headers: { Location: receiver.url('/internal') } }
          : { status: 200 };
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      expect(receiver.received.map((r) => r.path)).toEqual(['/hooks']);
      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastResponseStatus: 302,
      });
    });

    it('gives up on a store that never answers after the HTTP timeout', async () => {
      receiver.handler = () => 'hang';
      const { eventId } = await insertExpiredEvent();

      const started = Date.now();
      await worker.sendRequests();
      const elapsed = Date.now() - started;

      // WEBHOOK_HTTP_TIMEOUT_MS=1000 in .env.test; fetch's own default is minutes
      expect(elapsed).toBeLessThan(4000);
      const row = await eventRow(eventId);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(row.lastError).toMatch(/TimeoutError/);
    });

    it('one hanging store does not stop other stores getting their events', async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: receiver.url('/other'),
      });
      receiver.handler = (r) =>
        r.path === '/hooks' ? 'hang' : { status: 200 };
      const slow = await insertExpiredEvent();
      const fine = await insertExpiredEvent({}, other.storeId);

      await worker.sendRequests();

      expect((await eventRow(fine.eventId)).status).toBe('DELIVERED');
      expect((await eventRow(slow.eventId)).status).toBe('PENDING');
    });

    it('records an unreachable store as a failure', async () => {
      // grab a free port, then close it so nothing listens there
      // (not port 1: fetch refuses "bad ports" before even connecting)
      const probe = http.createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const { port } = probe.address() as AddressInfo;
      await new Promise<void>((r) => probe.close(() => r()));
      await setStoreUrl(`http://127.0.0.1:${port}/hooks`);
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      const row = await eventRow(eventId);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      // Linux refuses instantly; Windows retries the SYN and may hit the timeout first
      expect(row.lastError).toMatch(/ECONNREFUSED|TimeoutError/);
    });

    it('never sends an event whose payment is still PENDING (a bug upstream)', async () => {
      seq += 1;
      const payment = await prisma.payment.create({
        data: {
          status: 'PENDING',
          amountCents: 1500n,
          idempotencyKey: `key-${seq}`,
          requestHash: `hash-${seq}`,
          returnUrl: 'https://shop.example.com/return',
          orderId: `order-${seq}`,
          storeId: store.storeId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const row = await prisma.webhookEvent.create({
        data: { paymentId: payment.id },
      });

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(0);
      expect(await eventRow(row.id)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'Payment is still PENDING',
      });
    });
  });

  // ---------- Phase 2's "done when" ----------

  describe('store outage and recovery', () => {
    it('a store that is down across many retries still gets the event, once, with the same id', async () => {
      let up = false;
      receiver.handler = () => ({ status: up ? 200 : 503 });
      const { eventId } = await insertExpiredEvent();

      // 10 failed attempts ≈ 85 min of real backoff: the store was down for over an hour
      for (let i = 0; i < 10; i++) {
        await worker.sendRequests();
        await makeDue(eventId);
      }
      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: 10,
      });

      up = true;
      await worker.sendRequests();

      const row = await eventRow(eventId);
      expect(row).toMatchObject({
        status: 'DELIVERED',
        attempts: 10,
        lastError: null,
        lastResponseStatus: 200,
      });
      expect(receiver.received).toHaveLength(11);
      // every retry carried the same event id, so the store can dedupe
      expect(new Set(receiver.bodies().map((b) => b.id))).toEqual(
        new Set([eventId]),
      );
      await assertAllInvariants();
    });
  });

  // ---------- dead letter ----------

  describe('dead letter', () => {
    it(`moves an event to FAILED on attempt ${MAX_ATTEMPTS} and owes the store an alert`, async () => {
      receiver.handler = () => ({ status: 500 });
      const { eventId } = await insertExpiredEvent({
        attempts: MAX_ATTEMPTS - 1,
      });

      await worker.sendRequests();

      const row = await eventRow(eventId);
      expect(row).toMatchObject({
        status: 'FAILED',
        attempts: MAX_ATTEMPTS,
        lockedUntil: null,
        deliveredAt: null,
        lastResponseStatus: 500,
        lastError: 'Store responded with 500',
      });
      const s = await storeRow();
      expect(s.webhookAlertOwedAt).toEqual(row.lastTried);
      expect(s.webhookAlertSentAt).toBeNull();
    });

    it('one attempt before the limit is still just a retry', async () => {
      receiver.handler = () => ({ status: 500 });
      const { eventId } = await insertExpiredEvent({
        attempts: MAX_ATTEMPTS - 2,
      });

      await worker.sendRequests();

      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: MAX_ATTEMPTS - 1,
      });
      expect((await storeRow()).webhookAlertOwedAt).toBeNull();
    });

    it('a dead-lettered event is never retried automatically', async () => {
      receiver.handler = () => ({ status: 500 });
      const { eventId } = await insertExpiredEvent({
        attempts: MAX_ATTEMPTS - 1,
      });
      await worker.sendRequests();
      await makeDue(eventId);

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(1);
    });

    it('keeps the earliest owed time when another event dies later', async () => {
      const earlier = new Date(Date.now() - 86_400_000);
      await prisma.store.update({
        where: { id: store.storeId },
        data: { webhookAlertOwedAt: earlier },
      });
      receiver.handler = () => ({ status: 500 });
      await insertExpiredEvent({ attempts: MAX_ATTEMPTS - 1 });

      await worker.sendRequests();

      expect((await storeRow()).webhookAlertOwedAt).toEqual(earlier);
    });

    it('does not owe a new alert while the last one is still standing (sentAt set)', async () => {
      const sent = new Date(Date.now() - 3_600_000);
      await prisma.store.update({
        where: { id: store.storeId },
        data: { webhookAlertSentAt: sent },
      });
      receiver.handler = () => ({ status: 500 });
      const { eventId } = await insertExpiredEvent({
        attempts: MAX_ATTEMPTS - 1,
      });

      await worker.sendRequests();

      expect((await eventRow(eventId)).status).toBe('FAILED');
      expect(await storeRow()).toEqual({
        webhookAlertOwedAt: null,
        webhookAlertSentAt: sent,
      });
    });

    it('several events dying in one tick owe one alert', async () => {
      receiver.handler = () => ({ status: 500 });
      await insertExpiredEvent({ attempts: MAX_ATTEMPTS - 1 });
      await insertExpiredEvent({ attempts: MAX_ATTEMPTS - 1 });

      await worker.sendRequests();

      expect(
        await prisma.webhookEvent.count({ where: { status: 'FAILED' } }),
      ).toBe(2);
      expect((await storeRow()).webhookAlertOwedAt).toBeInstanceOf(Date);
    });

    it('only the failing store is owed an alert', async () => {
      const other = await createStore(app, {
        email: 'other@test.com',
        webhookUrl: receiver.url('/other'),
      });
      receiver.handler = (r) => ({ status: r.path === '/hooks' ? 500 : 200 });
      await insertExpiredEvent({ attempts: MAX_ATTEMPTS - 1 });
      await insertExpiredEvent({ attempts: MAX_ATTEMPTS - 1 }, other.storeId);

      await worker.sendRequests();

      expect((await storeRow()).webhookAlertOwedAt).toBeInstanceOf(Date);
      expect((await storeRow(other.storeId)).webhookAlertOwedAt).toBeNull();
    });
  });

  describe('alert reset on delivery', () => {
    it('a successful delivery clears sentAt but never owedAt', async () => {
      const owed = new Date(Date.now() - 7_200_000);
      const sent = new Date(Date.now() - 3_600_000);
      await prisma.store.update({
        where: { id: store.storeId },
        data: { webhookAlertOwedAt: owed, webhookAlertSentAt: sent },
      });
      await insertExpiredEvent();

      await worker.sendRequests();

      expect(await storeRow()).toEqual({
        webhookAlertOwedAt: owed, // other events may still be dead
        webhookAlertSentAt: null,
      });
    });

    it("does not touch another store's alert columns", async () => {
      const other = await createStore(app, { email: 'other@test.com' });
      const sent = new Date(Date.now() - 3_600_000);
      await prisma.store.update({
        where: { id: other.storeId },
        data: { webhookAlertSentAt: sent },
      });
      await insertExpiredEvent();

      await worker.sendRequests();

      expect((await storeRow(other.storeId)).webhookAlertSentAt).toEqual(sent);
    });

    it('a failed attempt does not clear sentAt', async () => {
      const sent = new Date(Date.now() - 3_600_000);
      await prisma.store.update({
        where: { id: store.storeId },
        data: { webhookAlertSentAt: sent },
      });
      receiver.handler = () => ({ status: 500 });
      await insertExpiredEvent();

      await worker.sendRequests();

      expect((await storeRow()).webhookAlertSentAt).toEqual(sent);
    });
  });

  // ---------- leases and concurrency ----------

  describe('leases', () => {
    // While our request is in flight, "another worker" takes the row over
    // (as if our lease had expired and it re-claimed). Our write-back must
    // then leave the row alone.
    const stealLeaseDuringSend = (reply: Reply) => {
      const stolen = new Date(Date.now() + 120_000);
      receiver.handler = async (r) => {
        await prisma.webhookEvent.update({
          where: { id: (JSON.parse(r.body) as WebhookBody).id },
          data: { lockedUntil: stolen },
        });
        return reply;
      };
      return stolen;
    };

    it('holds a lease while sending', async () => {
      let leaseDuringSend: Date | null = null;
      receiver.handler = async (r) => {
        leaseDuringSend = (
          await eventRow((JSON.parse(r.body) as WebhookBody).id)
        ).lockedUntil;
        return { status: 200 };
      };
      await insertExpiredEvent();

      await worker.sendRequests();

      expect(leaseDuringSend).toBeInstanceOf(Date);
      expect(leaseDuringSend!.getTime()).toBeGreaterThan(Date.now());
    });

    it('a success write-back is dropped if the lease was lost', async () => {
      const stolen = stealLeaseDuringSend({ status: 200 });
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        lockedUntil: stolen,
        deliveredAt: null,
      });
    });

    it('a failure write-back is dropped if the lease was lost', async () => {
      const stolen = stealLeaseDuringSend({ status: 500 });
      const { eventId } = await insertExpiredEvent();

      await worker.sendRequests();

      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        lockedUntil: stolen,
        lastError: null,
      });
    });

    it('a dead letter is dropped, and no alert owed, if the lease was lost', async () => {
      stealLeaseDuringSend({ status: 500 });
      const { eventId } = await insertExpiredEvent({
        attempts: MAX_ATTEMPTS - 1,
      });

      await worker.sendRequests();

      expect(await eventRow(eventId)).toMatchObject({
        status: 'PENDING',
        attempts: MAX_ATTEMPTS - 1,
      });
      expect((await storeRow()).webhookAlertOwedAt).toBeNull();
    });
  });

  describe('concurrency', () => {
    it('two worker instances ticking at once send each event exactly once', async () => {
      // a second instance shares nothing in memory: only the DB claim keeps them apart
      const second = new WebhookWorker(
        prisma,
        app.get(ConfigService),
        app.get(SchedulerRegistry),
      );
      receiver.handler = async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { status: 200 };
      };
      await insertManyExpiredEvents(150);

      await Promise.all([worker.sendRequests(), second.sendRequests()]);

      const ids = receiver.bodies().map((b) => b.id);
      expect(ids).toHaveLength(150);
      expect(new Set(ids).size).toBe(150);
      expect(
        await prisma.webhookEvent.count({ where: { status: 'DELIVERED' } }),
      ).toBe(150);
    });

    it('overlapping ticks on one instance do not double-send', async () => {
      receiver.handler = async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { status: 200 };
      };
      await insertExpiredEvent();

      await Promise.all([worker.sendRequests(), worker.sendRequests()]);

      expect(receiver.received).toHaveLength(1);
    });

    it('recovers after a tick fails: the running flag is reset', async () => {
      vi.spyOn(prisma.webhookEvent, 'findMany').mockRejectedValueOnce(
        new Error('db blip'),
      );
      await worker.sendRequests(); // logs, never throws
      vi.restoreAllMocks();
      await insertExpiredEvent();

      await worker.sendRequests();

      expect(receiver.received).toHaveLength(1);
    });
  });
});
