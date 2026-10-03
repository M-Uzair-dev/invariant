import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createHash } from 'crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    let token: string | null = req.headers['authorization'];
    if (!token || !token.startsWith('Bearer ')) {
      throw new UnauthorizedException('Api Key invalid.');
    }
    token = token.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const store = await this.prisma.store.findUnique({
      where: {
        secretKeyHash: tokenHash,
      },
      select: {
        id: true,
        webhookUrl: true,
      },
    });
    if (!store) throw new UnauthorizedException('Api Key invalid.');
    req.store = {
      storeId: store.id,
      webhookUrl: store.webhookUrl,
    };
    return true;
  }
}
