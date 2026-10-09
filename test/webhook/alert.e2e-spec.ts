import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MAILER, Mailer } from '../../src/mail/mailer';
import { PrismaService } from '../../src/utils/prisma/prisma.service';
import { FailedWebhookWorker } from '../../src/webhook/failedWebhooks.worker';
import { WebhookWorker } from '../../src/webhook/webhook.worker';
import { resetState } from '../helpers';

type Sent = { to: string; subject: string; body: string };

// Stands in for MAILER: records every send, can fail chosen addresses, can be slowed down.
class FakeMailer implements Mailer {
  sent: Sent[] = [];
  failFor = new Set<string>();
  failAll = false;
  delayMs = 0;

  async sendEmail(to: string, subject: string, body: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failAll || this.failFor.has(to)) {
      throw new Error(`mail provider rejected ${to}`);
    }
    this.sent.push({ to, subject, body });
  }

  reset() {
    this.sent = [];
    this.failFor.clear();
    this.failAll = false;
    this.delayMs = 0;
  }

  recipients() {
    return this.sent.map((s) => s.to).sort();
  }
}

const MAX_ATTEMPTS = 34;

describe('Webhook alert job (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FailedWebhookWorker;
  const mailer = new FakeMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    worker = app.get(FailedWebhookWorker);
  });

  beforeEach(async () => {
    await resetState(app);
    mailer.reset();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- helpers ----------

  let seq = 0;
  // Stores are inserted directly: signing up through the API (bcrypt) is too slow for bulk tests.
  const insertStore = async (
    alert: { owedAt?: Date | null; sentAt?: Date | null } = {},
  ) => {
    seq += 1;
    const account = await prisma.account.create({ data: { type: 'STORE' } });
    return prisma.store.create({
      data: {
        name: `Shop ${seq}`,
        email: `shop${seq}@test.com`,
        passwordHash: 'x',
        secretKeyHash: `key-hash-${seq}`,
        webhookSigningSecret: `whsec-${seq}`,
        accountId: account.id,
        webhookAlertOwedAt: alert.owedAt ?? null,
        webhookAlertSentAt: alert.sentAt ?? null,
      },
      select: { id: true, email: true },
    });
  };

  const insertManyOwedStores = async (count: number) => {
    const owedAt = new Date(Date.now() - 60_000);
    const accounts = await prisma.account.createManyAndReturn({
      data: Array.from({ length: count }, () => ({ type: 'STORE' as const })),
      select: { id: true },
    });
    await prisma.store.createMany({
      data: accounts.map((a, i) => ({
        name: `Bulk ${i}`,
        email: `bulk${i}@test.com`,
        passwordHash: 'x',
        secretKeyHash: `bulk-key-${i}`,
        webhookSigningSecret: `bulk-whsec-${i}`,
        accountId: a.id,
        webhookAlertOwedAt: owedAt,
      })),
    });
  };

  const alertCols = (id: string) =>
    prisma.store.findUniqueOrThrow({
      where: { id },
      select: { webhookAlertOwedAt: true, webhookAlertSentAt: true },
    });

  const owedCount = () =>
    prisma.store.count({ where: { webhookAlertOwedAt: { not: null } } });

  const owedNow = () => ({ owedAt: new Date(Date.now() - 60_000) });

  // ---------- wiring ----------

  describe('wiring', () => {
    it('is registered, and the timer is off when WEBHOOK_ALERT_INTERVAL_MS=0', () => {
      expect(worker).toBeInstanceOf(FailedWebhookWorker);
      expect(app.get(SchedulerRegistry).getIntervals()).not.toContain(
        'webhook-alert',
      );
    });

    it('does nothing when no store is owed an alert', async () => {
      await insertStore();
      await worker.sendFailureEmails();
      expect(mailer.sent).toHaveLength(0);
    });
  });

  // ---------- sending ----------

  describe('sending an alert', () => {
    it('emails an owed store at its address, then marks it sent and clears owedAt', async () => {
      const store = await insertStore(owedNow());
      const before = Date.now();

      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe(store.email);
      const cols = await alertCols(store.id);
      expect(cols.webhookAlertOwedAt).toBeNull();
      expect(cols.webhookAlertSentAt).not.toBeNull();
      expect(cols.webhookAlertSentAt!.getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it('sends nothing for stores that are not owed, whatever their sentAt', async () => {
      await insertStore();
      await insertStore({ sentAt: new Date() });

      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(0);
    });

    it('only owed stores are emailed, and the others are left untouched', async () => {
      const owed = await insertStore(owedNow());
      const muted = await insertStore({ sentAt: new Date(Date.now() - 5000) });
      const mutedBefore = await alertCols(muted.id);

      await worker.sendFailureEmails();

      expect(mailer.recipients()).toEqual([owed.email]);
      expect(await alertCols(muted.id)).toEqual(mutedBefore);
    });

    it('sends each owed alert once: a second tick sends nothing', async () => {
      await insertStore(owedNow());

      await worker.sendFailureEmails();
      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(1);
    });

    it('drains 250 owed stores in one tick (batches of 100), each emailed once', async () => {
      await insertManyOwedStores(250);

      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(250);
      expect(new Set(mailer.recipients()).size).toBe(250);
      expect(await owedCount()).toBe(0);
    });
  });

  // ---------- failures ----------

  describe('failed sends', () => {
    it('keeps the alert owed when the send fails, and retries it on the next tick', async () => {
      const store = await insertStore(owedNow());
      const owedBefore = (await alertCols(store.id)).webhookAlertOwedAt;
      mailer.failAll = true;

      await worker.sendFailureEmails(); // logs, never throws

      expect(await alertCols(store.id)).toEqual({
        webhookAlertOwedAt: owedBefore,
        webhookAlertSentAt: null,
      });

      mailer.failAll = false;
      await worker.sendFailureEmails();

      expect(mailer.recipients()).toEqual([store.email]);
      expect((await alertCols(store.id)).webhookAlertOwedAt).toBeNull();
    });

    it('one store whose send fails does not block the others', async () => {
      const bad = await insertStore(owedNow());
      const good1 = await insertStore(owedNow());
      const good2 = await insertStore(owedNow());
      mailer.failFor.add(bad.email);

      await worker.sendFailureEmails();

      expect(mailer.recipients()).toEqual([good1.email, good2.email].sort());
      expect((await alertCols(bad.id)).webhookAlertOwedAt).not.toBeNull();
      expect((await alertCols(good1.id)).webhookAlertOwedAt).toBeNull();
      expect((await alertCols(good2.id)).webhookAlertOwedAt).toBeNull();
    });

    it('a tick ends when every send fails, even with more than one batch owed', async () => {
      // without a cursor, the same 100 stores would come back forever
      await insertManyOwedStores(250);
      mailer.failAll = true;
      const sendSpy = vi.spyOn(mailer, 'sendEmail');

      await worker.sendFailureEmails();

      expect(sendSpy).toHaveBeenCalledTimes(250);
      expect(new Set(sendSpy.mock.calls.map((c) => c[0])).size).toBe(250);
      expect(await owedCount()).toBe(250);
    });

    it('a crash between the send and the update re-sends next tick (at-least-once)', async () => {
      const store = await insertStore(owedNow());
      vi.spyOn(prisma.store, 'updateMany').mockRejectedValueOnce(
        new Error('db blip'),
      );

      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(1);
      expect((await alertCols(store.id)).webhookAlertOwedAt).not.toBeNull();

      await worker.sendFailureEmails();

      expect(mailer.recipients()).toEqual([store.email, store.email]);
      expect((await alertCols(store.id)).webhookAlertOwedAt).toBeNull();
    });
  });

  // ---------- full cycle with the delivery worker ----------

  describe('alert cycle with the delivery worker', () => {
    // A store with no webhook URL: every attempt fails without any HTTP.
    const deadLetterOneEvent = async (storeId: string) => {
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
      await prisma.webhookEvent.create({
        data: { paymentId: payment.id, attempts: MAX_ATTEMPTS - 1 },
      });
      await app.get(WebhookWorker).sendRequests();
    };

    it('dead letter → one email → muted → re-armed by a delivery → next dead letter emails again', async () => {
      const store = await insertStore();

      await deadLetterOneEvent(store.id);
      await worker.sendFailureEmails();
      expect(mailer.sent).toHaveLength(1);

      // muted: another death while sentAt is set owes nothing
      await deadLetterOneEvent(store.id);
      expect((await alertCols(store.id)).webhookAlertOwedAt).toBeNull();
      await worker.sendFailureEmails();
      expect(mailer.sent).toHaveLength(1);

      // a successful delivery clears sentAt (re-arms, sends nothing)
      await prisma.store.update({
        where: { id: store.id },
        data: { webhookAlertSentAt: null },
      });
      await worker.sendFailureEmails();
      expect(mailer.sent).toHaveLength(1);

      // the next death owes a new alert
      await deadLetterOneEvent(store.id);
      await worker.sendFailureEmails();
      expect(mailer.recipients()).toEqual([store.email, store.email]);
    });
  });

  // ---------- concurrency ----------

  describe('concurrency', () => {
    it('two instances ticking at once: every owed store is emailed and cleared, nothing throws', async () => {
      // the update's owedAt guard stops double-marking; a duplicate email is the accepted cost
      const second = new FailedWebhookWorker(
        prisma,
        mailer,
        app.get(ConfigService),
        app.get(SchedulerRegistry),
      );
      await insertManyOwedStores(30);
      mailer.delayMs = 20;

      await Promise.all([
        worker.sendFailureEmails(),
        second.sendFailureEmails(),
      ]);

      expect(new Set(mailer.recipients()).size).toBe(30);
      expect(mailer.sent.length).toBeLessThanOrEqual(60);
      expect(await owedCount()).toBe(0);
    });

    it('overlapping ticks on one instance do not double-send', async () => {
      await insertStore(owedNow());
      mailer.delayMs = 100;

      await Promise.all([
        worker.sendFailureEmails(),
        worker.sendFailureEmails(),
      ]);

      expect(mailer.sent).toHaveLength(1);
    });

    it('recovers after a tick fails: the running flag is reset', async () => {
      vi.spyOn(prisma.store, 'findMany').mockRejectedValueOnce(
        new Error('db blip'),
      );
      await worker.sendFailureEmails(); // logs, never throws
      await insertStore(owedNow());

      await worker.sendFailureEmails();

      expect(mailer.sent).toHaveLength(1);
    });
  });
});
