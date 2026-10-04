import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { TokenModule } from '../tokens/token.module';

@Module({
  imports: [TokenModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
