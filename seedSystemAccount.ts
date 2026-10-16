import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './src/generated/prisma/client';
import { ensureSystemAccount } from './prisma/ensureSystemAccount';

// Entry point for `npx prisma db seed`. Don't import this file: it runs on load.
expand(config()); // DATABASE_URL in .env is built from the PG_* vars
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  }),
});

ensureSystemAccount(prisma)
  .then((id) => {
    console.log('System account id: ', id);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
