import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../tokens/token.service';
import { Reflector } from '@nestjs/core';
import { UserType } from '../../types/userRolesType';
import { USER_TYPES_KEY } from '../decorators/auth.decorator';
import { Request } from 'express';
import { AuthUser } from '../decorators/user.param';
import { SESSION_COOKIE } from '../session-cookie';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthUser;
      }
    >();
    const cookie: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof cookie !== 'string' || !cookie) {
      throw new UnauthorizedException('Unauthorized, please login.');
    }
    const res = await this.tokenService.verifyToken(cookie);

    if (res) {
      const userTypes = this.reflector.getAllAndOverride<UserType[]>(
        USER_TYPES_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (userTypes?.includes(res.userType)) {
        request.user = {
          userId: res.userId,
          sessionKey: res.sessionKey,
          userType: res.userType,
        };
        return true;
      } else {
        throw new ForbiddenException(
          'Permission denied, resouce cannot be accessed.',
        );
      }
    } else {
      throw new UnauthorizedException('Invalid token, please login!');
    }
  }
}
