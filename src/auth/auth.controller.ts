import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserSignupDto } from './dto/userSignup.dto';
import { UserLoginDto } from './dto/userLogin.dto';
import { CurrentUser } from '../utils/decorators/user.param';
import { Auth } from '../utils/decorators/auth.decorator';
import { StoreLoginDto } from './dto/storeLogin.dto';
import { StoreSignupDto } from './dto/storeSignup.dto';

@Controller('auth')
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
  @Post('logout')
  @HttpCode(204)
  async userLogout(@CurrentUser('sessionKey') sessionKey: string) {
    await this.authService.logout(sessionKey);
    return;
  }

  @Post('login-store')
  storeLogin(@Body() data: StoreLoginDto) {
    return this.authService.storeLogin(data.email, data.password);
  }

  @Post('signup-store')
  storeSignup(@Body() data: StoreSignupDto) {
    return this.authService.storeSignup(data.name, data.email, data.password);
  }
}
