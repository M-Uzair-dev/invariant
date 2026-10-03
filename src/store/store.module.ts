import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { TokenModule } from '../tokens/token.module';

@Module({
  imports: [TokenModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}
