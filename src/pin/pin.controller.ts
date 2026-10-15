import { Body, Controller, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser } from '../utils/decorators/user.param';
import { PinService } from './pin.service';
import { ChangePinDto, ResetPinDto } from './dto/pin.dto';
import { AuthRateLimitGuard } from '../utils/guards/rateLimit.guard';

@Auth('USER')
@Controller('profile/pin')
export class PinController {
  constructor(private readonly pinService: PinService) {}

  @Patch()
  @HttpCode(204)
  async changePin(
    @CurrentUser('userId') userId: string,
    @Body() data: ChangePinDto,
  ) {
    await this.pinService.changePin(userId, data.currentPin, data.newPin);
  }

  @Patch('forgot')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(204)
  async resetPin(
    @CurrentUser('userId') userId: string,
    @Body() data: ResetPinDto,
  ) {
    await this.pinService.resetPin(userId, data.password, data.newPin);
  }
}
