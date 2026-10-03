import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

export interface AuthStore {
  storeId: string;
  webhookUrl: string | null;
}

export const CurrentStore = createParamDecorator(
  (field: keyof AuthStore | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const store = request.store;
    if (!store)
      throw new UnauthorizedException(
        'Secret key is required for this resouce.',
      );
    return field ? store[field] : store;
  },
);
