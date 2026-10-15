import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class RateLimitService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const redisKey = `rate:${key}`;
    const results = await this.redis
      .multi()
      .zremrangebyscore(redisKey, 0, now - windowMs)
      .zadd(redisKey, now, `${now}-${randomUUID()}`)
      .zcard(redisKey)
      .pexpire(redisKey, windowMs)
      .exec();
    const [countError, count] = results?.[2] ?? [new Error('no result')];
    if (countError || typeof count !== 'number') {
      throw countError ?? new Error(`rate limit count was ${String(count)}`);
    }
    return count <= limit;
  }
}

@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
