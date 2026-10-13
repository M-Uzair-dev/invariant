import { Module } from '@nestjs/common';
import { TokenModule } from '../tokens/token.module';
import { PinController } from './pin.controller';
import { PinService } from './pin.service';

@Module({
  imports: [TokenModule],
  controllers: [PinController],
  providers: [PinService],
  exports: [PinService],
})
export class PinModule {}
