import { Module } from '@nestjs/common';
import { PrismaModule } from '../utils/prisma/prisma.module';
import { AuthService } from './auth.service';
import { TokenModule } from '../tokens/token.module';
import { AuthController } from './auth.controller';

@Module({
  imports: [PrismaModule, TokenModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
