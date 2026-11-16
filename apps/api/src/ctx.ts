import { type Db } from '@shop/db';
import { type Env } from './env';

/** Injectable time source: production uses the system clock, tests move a fake one. */
export type Clock = { now: () => Date };
export const systemClock: Clock = { now: () => new Date() };

/** Everything business functions need. Plain data + functions: no service classes. */
export type AppCtx = { db: Db; env: Env; clock: Clock };

export const CTX = Symbol('APP_CTX');

export const moneyConfig = (env: Env) => ({
  deliveryFee: env.DELIVERY_FEE_KOPECKS,
  freeDeliveryFrom: env.FREE_DELIVERY_FROM_KOPECKS,
});
