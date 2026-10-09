import { Module } from '@nestjs/common';
import { LogMailer } from './log.mailer';
import { MAILER } from './mailer';

@Module({
  providers: [{ provide: MAILER, useClass: LogMailer }],
  exports: [MAILER],
})
export class MailModule {}
