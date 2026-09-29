import { Global, Module } from '@nestjs/common';
import { Redis } from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () =>
        new Redis({
          port: Number(process.env.REDIS_PORT) || 6379,
          host: process.env.REDIS_HOST || '127.0.0.1',
        }),
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
