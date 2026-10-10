import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserSignupDto } from './dto/userSignup.dto';
import { UserLoginDto } from './dto/userLogin.dto';
import { CurrentUser } from '../utils/decorators/user.param';
import { Auth } from '../utils/decorators/auth.decorator';
import { StoreLoginDto } from './dto/storeLogin.dto';
import { StoreSignupDto } from './dto/storeSignup.dto';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '../utils/session-cookie';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge:
        Number(this.config.getOrThrow('SESSION_MAX_LIFETIME_SECONDS')) * 1000,
    });
  }

  @Post('signup-user')
  async userSignup(
    @Body() data: UserSignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.authService.userSignup(
      data.name,
      data.email,
      data.password,
    );
    this.setCookie(res, token);
    return { success: true };
  }

  @Post('login-user')
  async userLogin(
    @Body() data: UserLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.authService.userLogin(
      data.email,
      data.password,
    );
    this.setCookie(res, token);
    return { success: true };
  }

  @Auth('STORE', 'USER')
  @Post('logout')
  @HttpCode(204)
  async userLogout(
    @CurrentUser('sessionKey') sessionKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(sessionKey);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return;
  }

  @Post('login-store')
  async storeLogin(
    @Body() data: StoreLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.authService.storeLogin(
      data.email,
      data.password,
    );
    this.setCookie(res, token);
    return { success: true };
  }

  @Post('signup-store')
  async storeSignup(
    @Body() data: StoreSignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await this.authService.storeSignup(
      data.name,
      data.email,
      data.password,
    );
    this.setCookie(res, response.token);
    return {
      secretKey: response.secretKey,
      signingSecret: response.signingSecret,
    };
  }
}
