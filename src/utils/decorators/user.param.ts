import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { UserType } from '../../types/userRolesType';

export interface AuthUser {
  userId: string;
  sessionKey: string;
  userType: UserType;
}

export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user)
      throw new UnauthorizedException('Please login to access this service.');
    return field ? user[field] : user;
  },
);
