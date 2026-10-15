import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RateLimitService } from '../rate-limit/rate-limit.service';

const tooMany = () =>
  new HttpException(
    'Too many requests. Try again later.',
    HttpStatus.TOO_MANY_REQUESTS,
  );

@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(GlobalRateLimitGuard.name);
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    this.limit = Number(config.get('RATE_LIMIT_GLOBAL_MAX', 100));
    this.windowMs = Number(config.get('RATE_LIMIT_WINDOW_MS', 60_000));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    try {
      const allowed = await this.rateLimit.hit(
        `global:${req.ip}`,
        this.limit,
        this.windowMs,
      );
      if (!allowed) throw tooMany();
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.warn(
        `Global rate limit unavailable, allowing: ${(e as Error).message}`,
      );
    }
    return true;
  }
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthRateLimitGuard.name);
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    this.limit = Number(config.get('RATE_LIMIT_AUTH_MAX', 10));
    this.windowMs = Number(config.get('RATE_LIMIT_WINDOW_MS', 60_000));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    let allowed: boolean;
    try {
      allowed = await this.rateLimit.hit(
        `auth:${route}:${req.ip}`,
        this.limit,
        this.windowMs,
      );
    } catch (e) {
      this.logger.error(
        `Auth rate limit unavailable, refusing: ${(e as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Temporarily unavailable. Try again shortly.',
      );
    }
    if (!allowed) throw tooMany();
    return true;
  }
}
