import { Module } from '@nestjs/common';
import { RedisModule } from '../utils/redis/redis.module';
import { PrismaModule } from '../utils/prisma/prisma.module';
import { TokenService } from './token.service';

@Module({
  imports: [RedisModule, PrismaModule],
  providers: [TokenService],
  exports: [TokenService],
})
export class TokenModule {}
