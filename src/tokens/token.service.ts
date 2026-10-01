import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TokenService {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  createKey(token: string) {
    return 'session:' + createHash('sha256').update(token).digest('hex');
  }

  async generateToken(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const payload = {
      userId,
      createdAt: new Date(),
      expiresAt: new Date(
        Date.now() +
          Number(this.config.getOrThrow('SESSION_MAX_LIFETIME_SECONDS')) * 1000,
      ),
    };
    await this.redis.set(
      this.createKey(token),
      JSON.stringify(payload),
      'EX',
      Number(this.config.getOrThrow('INACTIVE_SESSION_TTL_SECONDS')),
    );
    return token;
  }
  async verifyToken(token: string): Promise<null | {
    userId: string;
    createdAt: Date;
    expiresAt: Date;
  }> {
    const key = this.createKey(token);
    const data = await this.redis.get(key);
    if (!data) {
      return null;
    } else {
      const parsed = JSON.parse(data);
      parsed.expiresAt = new Date(parsed.expiresAt);
      if (new Date() > parsed.expiresAt) {
        await this.redis.del(key);
        return null;
      }
      parsed.createdAt = new Date(parsed.createdAt);
      await this.redis.expire(
        key,
        this.config.getOrThrow('INACTIVE_SESSION_TTL_SECONDS'),
      );
      return parsed;
    }
  }
}
