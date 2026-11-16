import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_RATE_LIMIT } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { type AppRequest } from '../http/types';
import { enforce } from './rate-limit';

/** Global per-IP limiter (counters live in PostgreSQL, so it holds across api instances). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(CTX) private readonly ctx: AppCtx,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AppRequest>();
    await enforce(this.ctx, `api:ip:${req.clientIp}`, {
      windowSeconds: this.ctx.env.API_RATE_WINDOW_SECONDS,
      max: this.ctx.env.API_RATE_MAX_PER_IP,
    });
    return true;
  }
}
