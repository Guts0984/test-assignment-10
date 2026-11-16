import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type Role } from '@shop/shared';
import { type AppRequest, type SessionUser } from '../http/types';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';
export const SKIP_RATE_LIMIT = 'skipRateLimit';
export const SKIP_ORIGIN_CHECK = 'skipOriginCheck';

/** Route is reachable without a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route needs one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
export const SkipOriginCheck = () => SetMetadata(SKIP_ORIGIN_CHECK, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) throw new Error('CurrentUser used on a public route');
    return req.user;
  },
);
