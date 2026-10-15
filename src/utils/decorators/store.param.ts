import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export interface AuthStore {
  storeId: string;
  webhookUrl: string | null;
}

export const CurrentStore = createParamDecorator(
  (field: keyof AuthStore | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { store?: AuthStore }>();
    const store = request.store;
    if (!store)
      throw new UnauthorizedException(
        'Secret key is required for this resouce.',
      );
    return field ? store[field] : store;
  },
);
