import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../tokens/token.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}
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
    if (!res) {
      throw new UnauthorizedException('Invalid token, please login!');
    } else {
      request.user = { userId: res.userId };
      return true;
    }
  }
}
