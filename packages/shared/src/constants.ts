export const ROLES = ['customer', 'manager'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = [
  'awaiting_payment',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const DELIVERY_METHODS = ['pickup', 'courier'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const CANCEL_REASONS = ['customer', 'expired', 'manager'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Defaults from the assignment. The api reads real values from env. */
export const DEFAULT_MONEY_CONFIG = {
  deliveryFee: 10_000, // 100 ₴
  freeDeliveryFrom: 200_000, // 2 000 ₴ (after discount)
} as const;

export type MoneyConfig = { deliveryFee: number; freeDeliveryFrom: number };

/** Transitions a manager may perform with PATCH /orders/:id/status. */
export const MANAGER_TRANSITIONS: Readonly<Record<string, OrderStatus>> = {
  paid: 'shipped',
  shipped: 'delivered',
};

export function nextManagerStatus(current: OrderStatus): OrderStatus | null {
  return MANAGER_TRANSITIONS[current] ?? null;
}

/** Statuses from which the customer may cancel the whole order. */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = ['awaiting_payment', 'paid'];

export const ORDER_EVENT_TYPES = [
  'created',
  'payment_failed',
  'paid',
  'restored_after_late_payment',
  'auto_refunded_late_payment',
  'duplicate_payment_refunded',
  'cancelled',
  'expired',
  'shipped',
  'delivered',
  'return_requested',
  'refund_requested',
  'refund_succeeded',
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

export const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_transition',
  'insufficient_stock',
  'price_changed',
  'total_mismatch',
  'cart_empty',
  'promo_rejected',
  'idempotency_conflict',
  'return_window_closed',
  'return_exceeds_purchased',
  'rate_limited',
  'bad_signature',
  'payload_too_large',
  'order_too_large',
  'service_unavailable',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Order amounts are stored as 32-bit integers (kopecks): the largest possible is 2 147 483 647.
 * Above this limit (₴ 20 000 000) checkout says so clearly instead of failing deep in the database.
 */
export const MAX_ORDER_TOTAL_KOPECKS = 2_000_000_000;
