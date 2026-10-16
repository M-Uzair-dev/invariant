import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from './utils/prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getHealth() {
    // Both checks run in parallel; a failure in one doesn't hide the other.
    const [postgres, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
      this.redis
        .ping()
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
    ]);

    const health = {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'error',
      postgres,
      redis,
      uptime: Math.round(process.uptime()),
    };

    // 503 so the ALB and deploy.sh treat the instance as unhealthy.
    if (health.status !== 'ok') throw new ServiceUnavailableException(health);
    return health;
  }
}
