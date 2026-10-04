import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/utils/prisma/prisma.service';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export async function resetState(app: INestApplication) {
  // Safety check: refuse to wipe anything that isn't the test database
  if (!process.env.DATABASE_URL?.includes('invariant_test')) {
    throw new Error('Refusing to reset: DATABASE_URL is not the test database');
  }
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE "WebhookEvent", "Transfer", "Payment", "User", "Store", "Account" CASCADE',
  );
  await app.get<Redis>('REDIS_CLIENT').flushdb();
}

export interface TestStore {
  storeId: string;
  token: string;
  secretKey: string;
  signingSecret: string;
}

// Signs up a store through the real endpoint. Pass webhookUrl to set it
// directly in the DB: PUT /store/webhook resolves DNS, which tests shouldn't need.
export async function createStore(
  app: INestApplication,
  opts: { email?: string; webhookUrl?: string | null } = {},
): Promise<TestStore> {
  const email = opts.email ?? 'shop@test.com';
  const res = await request(app.getHttpServer())
    .post('/auth/signup-store')
    .send({ name: 'Shop', email, password: 'secret123' })
    .expect(201);

  const prisma = app.get(PrismaService);
  const store = await prisma.store.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  if (opts.webhookUrl !== undefined) {
    await prisma.store.update({
      where: { id: store.id },
      data: { webhookUrl: opts.webhookUrl },
    });
  }
  return { storeId: store.id, ...res.body };
}

export async function createUser(
  app: INestApplication,
  email = 'ali@test.com',
): Promise<{ token: string }> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup-user')
    .send({ name: 'Ali', email, password: 'secret123' })
    .expect(201);
  return res.body;
}
