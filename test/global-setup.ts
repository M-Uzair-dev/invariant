import { execSync } from 'node:child_process';
import { config } from 'dotenv';

export default function setup() {
  config({ path: '.env.test', override: true });
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
