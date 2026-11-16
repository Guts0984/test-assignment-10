import { z } from 'zod';
import type { PromoCreate } from '@shop/shared';
import { parseMoneyInput } from '@/shared/lib/format';

export const promoFormSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'required')
      .regex(/^[A-Za-z0-9_-]{3,32}$/, 'minLength'),
    type: z.enum(['percent', 'fixed']),
    value: z.string().trim().min(1, 'required'),
    minOrder: z.string().trim(),
    startsAt: z.string(),
    expiresAt: z.string(),
    maxUses: z.string().trim(),
    oncePerCustomer: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'percent') {
      if (!/^\d{1,3}$/.test(v.value) || Number(v.value) < 1 || Number(v.value) > 100)
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent' });
    } else {
      const k = parseMoneyInput(v.value);
      if (k === null || k <= 0)
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'amount' });
    }
    if (v.minOrder && parseMoneyInput(v.minOrder) === null)
      ctx.addIssue({ code: 'custom', path: ['minOrder'], message: 'amount' });
    if (v.maxUses && (!/^\d{1,7}$/.test(v.maxUses) || Number(v.maxUses) < 1))
      ctx.addIssue({ code: 'custom', path: ['maxUses'], message: 'positive' });
    if (v.startsAt && v.expiresAt && v.startsAt >= v.expiresAt)
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'dateOrder' });
  });
export type PromoFormValues = z.infer<typeof promoFormSchema>;

const iso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

export function toPromoPayload(v: PromoFormValues): PromoCreate {
  return {
    code: v.code,
    type: v.type,
    value: v.type === 'percent' ? Number(v.value) : (parseMoneyInput(v.value) ?? 0),
    minOrder: v.minOrder ? (parseMoneyInput(v.minOrder) ?? 0) : 0,
    startsAt: iso(v.startsAt),
    expiresAt: iso(v.expiresAt),
    maxUses: v.maxUses ? Number(v.maxUses) : null,
    oncePerCustomer: v.oncePerCustomer,
    active: true,
  };
}
