import { z } from 'zod';
import { uuid } from './common';

export const promoCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,32}$/, 'code: 3-32 chars, latin letters, digits, _ or -');

const dateTimeOrNull = z.iso.datetime({ offset: true }).nullable();

export const promoCreateSchema = z
  .object({
    code: promoCodeSchema,
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(1_000_000_000),
    minOrder: z.number().int().min(0).max(1_000_000_000).default(0),
    startsAt: dateTimeOrNull.default(null),
    expiresAt: dateTimeOrNull.default(null),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
    oncePerCustomer: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .refine((v) => v.type !== 'percent' || v.value <= 100, {
    message: 'percent must be between 1 and 100',
    path: ['value'],
  })
  .refine((v) => !v.startsAt || !v.expiresAt || v.startsAt < v.expiresAt, {
    message: 'expiresAt must be after startsAt',
    path: ['expiresAt'],
  });
export type PromoCreate = z.infer<typeof promoCreateSchema>;

export const promoUpdateSchema = z
  .object({
    minOrder: z.number().int().min(0).max(1_000_000_000),
    startsAt: dateTimeOrNull,
    expiresAt: dateTimeOrNull,
    maxUses: z.number().int().min(1).max(1_000_000).nullable(),
    oncePerCustomer: z.boolean(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PromoUpdate = z.infer<typeof promoUpdateSchema>;

export const promoDtoSchema = z.object({
  id: uuid,
  code: z.string(),
  type: z.enum(['percent', 'fixed']),
  value: z.number().int(),
  minOrder: z.number().int(),
  startsAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  used: z.number().int(),
  oncePerCustomer: z.boolean(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type PromoDto = z.infer<typeof promoDtoSchema>;
