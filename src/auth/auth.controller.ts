import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserSignupDto } from './dto/userSignup.dto';
import { UserLoginDto } from './dto/userLogin.dto';
import { AuthGuard } from '../utils/guards/auth.guard';
import { CurrentUser } from '../utils/decorators/user.param';
import { Auth } from '../utils/decorators/auth.decorator';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup-user')
  userSignup(@Body() data: UserSignupDto) {
    return this.authService.userSignup(data.name, data.email, data.password);
  }

  @Post('login-user')
  userLogin(@Body() data: UserLoginDto) {
    return this.authService.userLogin(data.email, data.password);
  }

  @Auth('STORE', 'USER')
  @Post('logout-user')
  @HttpCode(204)
  async userLogout(@CurrentUser('sessionKey') sessionKey: string) {
    await this.authService.userLogout(sessionKey);
    return;
  }
}
