import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserSignupDto } from './dto/userSignup.dto';
import { UserLoginDto } from './dto/userLogin.dto';

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
}
