import { z } from 'zod';
import type { ProductCreate } from '@shop/shared';
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
