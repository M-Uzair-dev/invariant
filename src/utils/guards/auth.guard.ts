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

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    let token = request.headers['authorization'];
    if (!token) throw new UnauthorizedException('Invalid token, please login!');
    if (token.startsWith('Bearer ')) {
      token = token.slice(7);
    } else {
      throw new UnauthorizedException('Invalid token, please login!');
    }
    const res = await this.tokenService.verifyToken(token);

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
