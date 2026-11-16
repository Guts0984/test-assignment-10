import { z } from 'zod';
import { uuid } from './common';
import { DELIVERY_METHODS } from '../constants';
import { PROMO_REJECT_REASONS } from '../promo';

export const cartItemPutSchema = z.object({ qty: z.number().int().min(1).max(999) });
export const productIdParam = z.object({ productId: uuid });
export const promoApplySchema = z.object({ code: z.string().trim().min(1).max(64) });

export const cartLineDtoSchema = z.object({
  productId: uuid,
  name: z.string(),
  qty: z.number().int(),
  /** current catalogue price */
  unitPrice: z.number().int(),
  /** price the customer saw / confirmed */
  priceSeen: z.number().int(),
  priceChanged: z.boolean(),
  available: z.number().int(),
  insufficientStock: z.boolean(),
  inactive: z.boolean(),
  subtotal: z.number().int(),
  discountShare: z.number().int(),
  net: z.number().int(),
});
export type CartLineDto = z.infer<typeof cartLineDtoSchema>;

export const cartPromoDtoSchema = z.object({
  code: z.string(),
  valid: z.boolean(),
  reason: z.enum(PROMO_REJECT_REASONS).nullable(),
  minOrder: z.number().int().nullable(),
  discount: z.number().int(),
});
export type CartPromoDto = z.infer<typeof cartPromoDtoSchema>;

export const cartDtoSchema = z.object({
  lines: z.array(cartLineDtoSchema),
  promo: cartPromoDtoSchema.nullable(),
  subtotal: z.number().int(),
  discount: z.number().int(),
  afterDiscount: z.number().int(),
  /** delivery cost per method, so the client can render the choice without guessing */
  delivery: z.record(z.enum(DELIVERY_METHODS), z.number().int()),
  /** quick flags for the UI */
  hasPriceChanges: z.boolean(),
  hasStockProblems: z.boolean(),
  /** how long an order holds its goods before it expires (server setting, shown at checkout) */
  reservationMinutes: z.number().int().min(1),
});
export type CartDto = z.infer<typeof cartDtoSchema>;
