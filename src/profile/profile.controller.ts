import { Body, Controller, HttpCode, Patch } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { Auth } from '../utils/decorators/auth.decorator';
import { CurrentUser, type AuthUser } from '../utils/decorators/user.param';
import { UpdateNameDto } from './dto/updateName.dto';
import { ChangePasswordDto } from './dto/changePassword.dto';

@Auth('USER', 'STORE')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Patch('name')
  updateName(@CurrentUser() user: AuthUser, @Body() data: UpdateNameDto) {
    return this.profileService.updateName(
      user.userType,
      user.userId,
      data.name,
    );
  }

  @Patch('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() data: ChangePasswordDto,
  ) {
    await this.profileService.changePassword(
      user.userType,
      user.userId,
      data.currentPassword,
      data.newPassword,
    );
  }
}
