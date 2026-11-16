import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { loginSchema, type LoginInput } from '@shop/shared';
import { CTX, type AppCtx } from '../ctx';
import { parseCookies, serializeCookie } from '../http/cookies';
import { type AppRequest } from '../http/types';
import { ZodPipe } from '../http/zod.pipe';
import { ApiZBody } from '../http/swagger-zod';
import { CurrentUser, Public } from './decorators';
import { login } from './login';
import { destroySession, SESSION_COOKIE } from './sessions';
import { type SessionUser } from '../http/types';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiZBody(loginSchema)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionUser> {
    const r = await login(this.ctx, body, req.clientIp);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, r.token, {
        maxAgeSeconds: this.ctx.env.SESSION_TTL_HOURS * 3600,
        secure: this.ctx.env.COOKIE_SECURE,
      }),
    );
    return r.user;
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await destroySession(this.ctx, token);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.ctx.env.COOKIE_SECURE }),
    );
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user;
  }
}
