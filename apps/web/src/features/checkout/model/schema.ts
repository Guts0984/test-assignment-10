import { z } from 'zod';
import type { Address, OrderCreate } from '@shop/shared';

const text = (min: number, max: number) =>
  z.string().trim().min(1, 'required').min(min, 'minLength').max(max, 'maxLength');

/**
 * Checkout form. Messages are translation keys under "validation". The address rules mirror
 * addressSchema from @shop/shared (the server validates again), but are checked field by field.
 */
export const checkoutFormSchema = z
  .object({
    deliveryMethod: z.enum(['pickup', 'courier']),
    fullName: z.string().trim(),
    phone: z.string().trim(),
    city: z.string().trim(),
    street: z.string().trim(),
    building: z.string().trim(),
    apartment: z.string().trim(),
    postalCode: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.deliveryMethod !== 'courier') return;
    const rules: [keyof typeof v, z.ZodType][] = [
      ['fullName', text(2, 100)],
      [
        'phone',
        z
          .string()
          .trim()
          .min(1, 'required')
          .regex(/^\+?[0-9(][0-9 ()-]{6,19}$/, 'phone'),
      ],
      ['city', text(2, 80)],
      ['street', text(2, 120)],
      ['building', text(1, 20)],
      ['apartment', z.string().trim().max(10, 'maxLength')],
      [
        'postalCode',
        z
          .string()
          .trim()
          .min(1, 'required')
          .regex(/^\d{5}$/, 'postalCode'),
      ],
    ];
    for (const [field, rule] of rules) {
      const r = rule.safeParse(v[field]);
      if (!r.success)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: r.error.issues[0]?.message ?? 'required',
        });
    }
  });
export type CheckoutFormValues = z.infer<typeof checkoutFormSchema>;

export const EMPTY_CHECKOUT_FORM: CheckoutFormValues = {
  deliveryMethod: 'pickup',
  fullName: '',
  phone: '',
  city: '',
  street: '',
  building: '',
  apartment: '',
  postalCode: '',
};

/** Form values -> POST /orders body (pickup sends no address at all). */
export function toOrderCreate(v: CheckoutFormValues, expectedTotal: number): OrderCreate {
  if (v.deliveryMethod === 'pickup') return { deliveryMethod: 'pickup', expectedTotal };
  const address: Address = {
    fullName: v.fullName,
    phone: v.phone,
    city: v.city,
    street: v.street,
    building: v.building,
    postalCode: v.postalCode,
    ...(v.apartment ? { apartment: v.apartment } : {}),
  };
  return { deliveryMethod: 'courier', address, expectedTotal };
}
