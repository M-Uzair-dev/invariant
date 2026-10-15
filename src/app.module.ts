import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './utils/prisma/prisma.module';
import { RedisModule } from './utils/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { ProfileModule } from './profile/profile.module';
import { PaymentModule } from './payment/payment.module';
import { AccountModule } from './account/account.module';
import { ScheduleModule } from '@nestjs/schedule';
import { WebhookModule } from './webhook/webhook.module';
import { PinModule } from './pin/pin.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitModule } from './utils/rate-limit/rate-limit.service';
import { GlobalRateLimitGuard } from './utils/guards/rateLimit.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    RateLimitModule,
    AuthModule,
    StoreModule,
    ProfileModule,
    PaymentModule,
    AccountModule,
    WebhookModule,
    PinModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: GlobalRateLimitGuard },
  ],
})
export class AppModule {}
