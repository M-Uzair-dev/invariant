import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { PrismaService } from '../utils/prisma/prisma.service';

// A 6-digit PIN has 1M combinations, so the attempt limit is the real protection.
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_SECONDS = 15 * 60;

@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private attemptsKey(userId: string) {
    return `pin-attempts:${userId}`;
  }

  hashPin(pin: string) {
    return bcrypt.hash(pin, 12);
  }

  // Call before any transaction, so the bcrypt compare never runs while holding locks.
  async verifyPin(userId: string, pin: string) {
    const key = this.attemptsKey(userId);
    // Reserve the attempt before comparing: INCR is atomic, so parallel guesses
    // can't all pass a "count < max" check. The window starts at the first attempt.
    const [[incrError, attempts]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, PIN_LOCK_SECONDS, 'NX')
      .exec()) as [[Error | null, unknown], [Error | null, unknown]];
    // exec() resolves (not rejects) when a queued command fails at runtime,
    // and null > 5 is false: without this, a broken counter means unlimited guesses.
    if (incrError || typeof attempts !== 'number') {
      this.logger.error(
        `PIN attempt counter unavailable for user ${userId}: ${incrError?.message ?? `got ${String(attempts)}`}`,
      );
      throw new ServiceUnavailableException(
        'PIN check is temporarily unavailable. Try again shortly.',
      );
    }
    if (attempts > PIN_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many incorrect PIN attempts. Try again later, or reset your PIN with your password.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pinHash: true },
    });
    if (!user)
      throw new UnauthorizedException(
        'User account not found, please login again.',
      );
    // '' = created before PINs existed; bcrypt would reject it as a malformed hash
    if (!user.pinHash || !(await bcrypt.compare(pin, user.pinHash))) {
      throw new ForbiddenException('Incorrect PIN.');
    }
    await this.redis.del(key);
  }

  async changePin(userId: string, currentPin: string, newPin: string) {
    await this.verifyPin(userId, currentPin);
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash: await this.hashPin(newPin) },
    });
  }

  async resetPin(userId: string, password: string, newPin: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new BadRequestException('Password is incorrect.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash: await this.hashPin(newPin) },
    });
    // A password reset also lifts a lockout
    await this.redis.del(this.attemptsKey(userId));
  }
}
