import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CTX, type AppCtx } from '../ctx';
import { AppError, forbidden, unauthorized } from '../http/errors';
import { parseCookies } from '../http/cookies';
import { type AppRequest } from '../http/types';
import { IS_PUBLIC, ROLES_KEY, SKIP_ORIGIN_CHECK } from './decorators';
import { findSessionUser, SESSION_COOKIE } from './sessions';
import { type Role } from '@shop/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (on top of SameSite=Lax): a browser always sends Origin on cross-site
 * state-changing requests. If it is present it must be one of ours.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    @Inject(CTX) private readonly ctx: AppCtx,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_ORIGIN_CHECK, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const origin = req.headers.origin;
    if (origin === undefined) return true; // not a browser cross-site request
    if (this.ctx.env.ALLOWED_ORIGINS.includes(origin)) return true;
    throw new AppError(403, 'forbidden', 'Origin not allowed');
  }
}

/** Resolves the session cookie to a user; routes are protected unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(CTX) private readonly ctx: AppCtx,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const user = await findSessionUser(this.ctx, token);
      if (user) req.user = user;
    }
    if (!req.user && !isPublic) throw unauthorized();
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden('Insufficient permissions');
    return true;
  }
}
