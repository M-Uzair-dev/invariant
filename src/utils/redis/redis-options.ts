import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

export function redisOptions(config: ConfigService): RedisOptions {
  return {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: Number(config.getOrThrow('REDIS_PORT')),
    username: config.get<string>('REDIS_USERNAME') || undefined,
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    tls: config.get('REDIS_TLS') === 'true' ? {} : undefined,
  };
}
