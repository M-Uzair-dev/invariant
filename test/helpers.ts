import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
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
