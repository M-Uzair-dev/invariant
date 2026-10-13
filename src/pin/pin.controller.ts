import { Body, Controller, HttpCode, Patch } from '@nestjs/common';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser } from '../utils/decorators/user.param';
import { PinService } from './pin.service';
import { ChangePinDto, ResetPinDto } from './dto/pin.dto';

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
  @HttpCode(204)
  async resetPin(
    @CurrentUser('userId') userId: string,
    @Body() data: ResetPinDto,
  ) {
    await this.pinService.resetPin(userId, data.password, data.newPin);
  }
}
