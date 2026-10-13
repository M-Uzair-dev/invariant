import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
} from '@nestjs/common';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser, type AuthUser } from '../utils/decorators/user.param';
import { AccountService } from './account.service';
import { TopupDto } from './dto/topup.dto';
import { PinService } from '../pin/pin.service';

@Controller('account')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly pinService: PinService,
  ) {}

  @Auth('USER')
  @Post('topup')
  async topup(
    @CurrentUser('userId') userId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TopupDto,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255)
      throw new BadRequestException(
        'Idempotency-Key header is required (max 255 characters).',
      );
    await this.pinService.verifyPin(userId, dto.pin);
    return this.accountService.topupAccount(
      userId,
      dto.amountCents,
      idempotencyKey,
    );
  }

  @Auth('USER', 'STORE')
  @Get('balance')
  getBalance(@CurrentUser() user: AuthUser) {
    return this.accountService.getAccountBalance(user.userId, user.userType);
  }
}
