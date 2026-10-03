import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { TokenModule } from '../tokens/token.module';

@Module({
  imports: [TokenModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
