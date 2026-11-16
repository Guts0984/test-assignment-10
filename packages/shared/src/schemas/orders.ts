import { z } from 'zod';
import { cursorSchema, isoDate, limitSchema, uuid } from './common';
import { DELIVERY_METHODS, ORDER_STATUSES } from '../constants';

export const addressSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9(][0-9 ()-]{6,19}$/, 'invalid phone'),
  city: z.string().trim().min(2).max(80),
  street: z.string().trim().min(2).max(120),
  building: z.string().trim().min(1).max(20),
  apartment: z.string().trim().max(10).optional(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'postal code must have 5 digits'),
});
export type Address = z.infer<typeof addressSchema>;

export const idempotencyKeySchema = uuid;

export const orderCreateSchema = z
  .object({
    deliveryMethod: z.enum(DELIVERY_METHODS),
    address: addressSchema.optional(),
    /** total the customer saw; if it differs from the server's calculation the order is refused */
    expectedTotal: z.number().int().min(0).optional(),
    /** alternative to the Idempotency-Key header */
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .refine((v) => v.deliveryMethod !== 'courier' || v.address !== undefined, {
    message: 'address is required for courier delivery',
    path: ['address'],
  });
export type OrderCreate = z.infer<typeof orderCreateSchema>;

export const payBodySchema = z.object({
  /** where the stub page sends the customer back to; same-site path only */
  returnUrl: z
    .string()
    .max(500)
    .regex(/^\/(?![/\\])[^\s]*$/, 'must be a same-site path')
    .optional(),
});

export const returnCreateSchema = z
  .object({
    items: z
      .array(z.object({ orderItemId: uuid, qty: z.number().int().min(1).max(999) }))
      .min(1)
      .max(100),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => new Set(v.items.map((i) => i.orderItemId)).size === v.items.length, {
    message: 'duplicate orderItemId',
    path: ['items'],
  });
export type ReturnCreate = z.infer<typeof returnCreateSchema>;

export const statusPatchSchema = z.object({ status: z.enum(['shipped', 'delivered']) });

export const orderListQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
    limit: limitSchema(20),
    cursor: cursorSchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from must be <= to',
    path: ['from'],
  });
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderItemDtoSchema = z.object({
  id: uuid,
  productId: uuid,
  name: z.string(),
  qty: z.number().int(),
  unitPrice: z.number().int(),
  discountShare: z.number().int(),
  net: z.number().int(),
  returnedQty: z.number().int(),
});
export type OrderItemDto = z.infer<typeof orderItemDtoSchema>;

export const orderEventDtoSchema = z.object({
  id: uuid,
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type OrderEventDto = z.infer<typeof orderEventDtoSchema>;

export const refundDtoSchema = z.object({
  id: uuid,
  amount: z.number().int(),
  kind: z.enum(['cancellation', 'return', 'late_payment', 'duplicate_payment']),
  status: z.enum(['pending', 'succeeded']),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RefundDto = z.infer<typeof refundDtoSchema>;

export const orderSummaryDtoSchema = z.object({
  id: uuid,
  number: z.string(),
  status: z.enum(ORDER_STATUSES),
  total: z.number().int(),
  refundedTotal: z.number().int(),
  deliveryMethod: z.enum(DELIVERY_METHODS),
  customerEmail: z.string().optional(),
  createdAt: z.string(),
});
export type OrderSummaryDto = z.infer<typeof orderSummaryDtoSchema>;

export const orderDtoSchema = orderSummaryDtoSchema.extend({
  subtotal: z.number().int(),
  discount: z.number().int(),
  delivery: z.number().int(),
  promoCode: z.string().nullable(),
  address: addressSchema.nullable(),
  reservedUntil: z.string().nullable(),
  cancelReason: z.enum(['customer', 'expired', 'manager']).nullable(),
  paidAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  /** true while a payment session exists whose notification may still arrive */
  pendingPayment: z.boolean(),
  returnableUntil: z.string().nullable(),
  items: z.array(orderItemDtoSchema),
  events: z.array(orderEventDtoSchema),
  refunds: z.array(refundDtoSchema),
});
export type OrderDto = z.infer<typeof orderDtoSchema>;

export const stockShortageSchema = z.object({
  productId: uuid,
  name: z.string(),
  requested: z.number().int(),
  available: z.number().int(),
});
export type StockShortage = z.infer<typeof stockShortageSchema>;
