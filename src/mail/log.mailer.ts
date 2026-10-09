import { Injectable, Logger } from '@nestjs/common';
import { Mailer } from './mailer';

@Injectable()
export class LogMailer implements Mailer {
  private readonly logger = new Logger(LogMailer.name);
  sendEmail(to: string, subject: string, body: string): Promise<void> {
    this.logger.log(`to=${to} subject="${subject}" body="${body}"`);
    return Promise.resolve();
  }
}
