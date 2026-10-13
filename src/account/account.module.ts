import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { TokenModule } from '../tokens/token.module';
import { PinModule } from '../pin/pin.module';

@Module({
  imports: [TokenModule, PinModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
