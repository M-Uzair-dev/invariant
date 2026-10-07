import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from './utils/prisma/prisma.module';
import { BullModule } from '@nestjs/bullmq';
import { RedisModule } from './utils/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { ProfileModule } from './profile/profile.module';
import { PaymentModule } from './payment/payment.module';
import { AccountModule } from './account/account.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: Number(config.getOrThrow('REDIS_PORT')),
        },
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AuthModule,
    StoreModule,
    ProfileModule,
    PaymentModule,
    AccountModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
