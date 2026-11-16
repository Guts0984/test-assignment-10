import { type Request } from 'express';
import { type Role } from '@shop/shared';

export type SessionUser = { id: string; email: string; name: string; role: Role };

export type AppRequest = Request & {
  requestId: string;
  clientIp: string;
  user?: SessionUser;
  rawBody?: Buffer;
};
