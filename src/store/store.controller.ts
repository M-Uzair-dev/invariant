import { Body, Controller, Put } from '@nestjs/common';
import { StoreService } from './store.service';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser } from '../utils/decorators/user.param';
import { SetWebhookDto } from './dto/setWebhook.dto';

@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Auth('STORE')
  @Put('webhook')
  setWebhook(
    @CurrentUser('userId') storeId: string,
    @Body() data: SetWebhookDto,
  ) {
    return this.storeService.setWebhookUrl(storeId, data.url);
  }
}
