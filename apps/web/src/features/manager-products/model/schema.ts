import { z } from 'zod';
import type { ProductCreate, ProductDto, ProductUpdate } from '@shop/shared';
import { parseMoneyInput } from '@/shared/lib/format';

export const productFormSchema = z.object({
  name: z.string().trim().min(1, 'required').min(2, 'minLength').max(200, 'maxLength'),
  categoryId: z.string().min(1, 'required'),
  price: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((v) => {
      const k = parseMoneyInput(v);
      return k !== null && k > 0;
    }, 'amount'),
  stock: z
    .string()
    .trim()
    .min(1, 'required')
    .regex(/^\d{1,7}$/, 'integer'),
  active: z.boolean(),
});
export type ProductFormValues = z.infer<typeof productFormSchema>;

export function toProductPayload(v: ProductFormValues): ProductCreate {
  return {
    name: v.name,
    categoryId: v.categoryId,
    price: parseMoneyInput(v.price) ?? 0,
    stock: Number(v.stock),
    active: v.active,
  };
}

/**
 * What an EDIT sends: only the fields the manager actually changed, and stock as a DIFFERENCE
 * ("+5") - never as an absolute number. The form shows the stock as it was when it was opened;
 * customers reserve and cancel while it is open, and an absolute save would silently overwrite
 * those movements (and then the same units could be sold twice).
 */
export function toProductChanges(v: ProductFormValues, was: ProductDto): ProductUpdate {
  const out: ProductUpdate = {};
  if (v.name !== was.name) out.name = v.name;
  if (v.categoryId !== was.categoryId) out.categoryId = v.categoryId;
  const price = parseMoneyInput(v.price) ?? 0;
  if (price !== was.price) out.price = price;
  const delta = Number(v.stock) - was.stock;
  if (delta !== 0) out.stockDelta = delta;
  if (v.active !== was.active) out.active = v.active;
  return out;
}
