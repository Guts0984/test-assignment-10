import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const roleEnum = pgEnum('role', ['customer', 'manager']);
export const orderStatusEnum = pgEnum('order_status', [
  'awaiting_payment',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
]);
export const cancelReasonEnum = pgEnum('cancel_reason', ['customer', 'expired', 'manager']);
export const deliveryMethodEnum = pgEnum('delivery_method', ['pickup', 'courier']);
export const promoTypeEnum = pgEnum('promo_type', ['percent', 'fixed']);
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'succeeded', 'failed']);
export const refundKindEnum = pgEnum('refund_kind', [
  'cancellation',
  'return',
  'late_payment',
  'duplicate_payment',
]);
export const refundStatusEnum = pgEnum('refund_status', ['pending', 'succeeded']);
export const jobStateEnum = pgEnum('job_state', ['pending', 'running', 'done', 'failed']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('customer'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
  },
  (t) => [
    uniqueIndex('categories_slug_uq').on(t.slug),
    uniqueIndex('categories_name_uq').on(t.name),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    /** kopecks */
    price: integer('price').notNull(),
    /** units available for sale (reserved units are already subtracted) */
    stock: integer('stock').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('products_price_positive', sql`${t.price} > 0`),
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
    index('products_category_price_idx').on(t.categoryId, t.price),
    index('products_price_idx').on(t.price, t.id),
    index('products_name_idx').on(t.name, t.id),
    index('products_created_idx').on(t.createdAt.desc(), t.id.desc()),
  ],
);

export const carts = pgTable('carts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  promoCode: text('promo_code'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const cartItems = pgTable(
  'cart_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    /** the price the customer has seen / confirmed */
    priceSeen: integer('price_seen').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    check('cart_items_qty_range', sql`${t.qty} between 1 and 999`),
  ],
);

export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** stored upper-cased: lookups are case-insensitive by construction */
    code: text('code').notNull(),
    type: promoTypeEnum('type').notNull(),
    value: integer('value').notNull(),
    minOrder: integer('min_order').notNull().default(0),
    startsAt: ts('starts_at'),
    expiresAt: ts('expires_at'),
    maxUses: integer('max_uses'),
    used: integer('used').notNull().default(0),
    oncePerCustomer: boolean('once_per_customer').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_codes_code_uq').on(t.code),
    check('promo_code_upper', sql`${t.code} = upper(${t.code})`),
    check('promo_value_positive', sql`${t.value} > 0`),
    check('promo_percent_range', sql`${t.type} <> 'percent' or ${t.value} <= 100`),
    check('promo_used_non_negative', sql`${t.used} >= 0`),
    // the usage limit can never be exceeded, whatever the application does
    check('promo_used_within_limit', sql`${t.maxUses} is null or ${t.used} <= ${t.maxUses}`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** ORD-<number>; contiguous, assigned from order_counter inside the creating transaction */
    number: integer('number').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: uuid('idempotency_key').notNull(),
    status: orderStatusEnum('status').notNull(),
    cancelReason: cancelReasonEnum('cancel_reason'),
    deliveryMethod: deliveryMethodEnum('delivery_method').notNull(),
    address: jsonb('address'),
    promoId: uuid('promo_id').references(() => promoCodes.id),
    promoCode: text('promo_code'),
    subtotal: integer('subtotal').notNull(),
    discount: integer('discount').notNull().default(0),
    delivery: integer('delivery').notNull().default(0),
    total: integer('total').notNull(),
    /** money returned to the customer so far (requested refunds count) */
    refundedTotal: integer('refunded_total').notNull().default(0),
    reservedUntil: ts('reserved_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
    paidAt: ts('paid_at'),
    shippedAt: ts('shipped_at'),
    deliveredAt: ts('delivered_at'),
    cancelledAt: ts('cancelled_at'),
  },
  (t) => [
    uniqueIndex('orders_number_uq').on(t.number),
    uniqueIndex('orders_user_idem_uq').on(t.userId, t.idempotencyKey),
    check('orders_total_formula', sql`${t.total} = ${t.subtotal} - ${t.discount} + ${t.delivery}`),
    check('orders_discount_range', sql`${t.discount} >= 0 and ${t.discount} <= ${t.subtotal}`),
    check('orders_refund_range', sql`${t.refundedTotal} >= 0 and ${t.refundedTotal} <= ${t.total}`),
    // manager list: filter by status and period, newest first
    index('orders_status_created_idx').on(t.status, t.createdAt.desc(), t.id.desc()),
    index('orders_created_idx').on(t.createdAt.desc(), t.id.desc()),
    // customer's own list
    index('orders_user_created_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    // sales report
    index('orders_paid_at_idx')
      .on(t.paidAt)
      .where(sql`${t.paidAt} is not null`),
    // reservation sweeper
    index('orders_reserved_until_idx')
      .on(t.reservedUntil)
      .where(sql`${t.status} = 'awaiting_payment'`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** product name at the time of the order */
    name: text('name').notNull(),
    qty: integer('qty').notNull(),
    /** price at the time of the order, kopecks */
    unitPrice: integer('unit_price').notNull(),
    discountShare: integer('discount_share').notNull().default(0),
    returnedQty: integer('returned_qty').notNull().default(0),
  },
  (t) => [
    check('order_items_qty_positive', sql`${t.qty} > 0`),
    check(
      'order_items_returned_range',
      sql`${t.returnedQty} >= 0 and ${t.returnedQty} <= ${t.qty}`,
    ),
    check(
      'order_items_discount_range',
      sql`${t.discountShare} >= 0 and ${t.discountShare} <= ${t.qty}::bigint * ${t.unitPrice}`,
    ),
    index('order_items_order_idx').on(t.orderId),
    index('order_items_product_idx').on(t.productId),
  ],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

export const promoRedemptions = pgTable(
  'promo_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoId: uuid('promo_id')
      .notNull()
      .references(() => promoCodes.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** copy of promo.once_per_customer at redemption time, enables the partial unique index below */
    oncePerCustomer: boolean('once_per_customer').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_redemptions_order_uq').on(t.orderId),
    uniqueIndex('promo_redemptions_once_uq')
      .on(t.promoId, t.userId)
      .where(sql`${t.oncePerCustomer}`),
    index('promo_redemptions_user_idx').on(t.userId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    check('payments_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Webhook idempotency: an event id is processed at most once. */
export const paymentEvents = pgTable('payment_events', {
  eventId: uuid('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

export const returns = pgTable(
  'returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    amount: integer('amount').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('returns_order_idx').on(t.orderId)],
);

export const returnItems = pgTable(
  'return_items',
  {
    returnId: uuid('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.returnId, t.orderItemId] }),
    check('return_items_qty', sql`${t.qty} > 0`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    returnId: uuid('return_id').references(() => returns.id, { onDelete: 'set null' }),
    amount: integer('amount').notNull(),
    kind: refundKindEnum('kind').notNull(),
    status: refundStatusEnum('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('refunds_order_idx').on(t.orderId),
    index('refunds_payment_idx').on(t.paymentId),
    check('refunds_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** PostgreSQL-backed job queue (no Redis, no external broker). */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    runAt: ts('run_at').notNull(),
    state: jobStateEnum('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedAt: ts('locked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('jobs_due_idx')
      .on(t.runAt)
      .where(sql`${t.state} = 'pending'`),
    index('jobs_running_idx')
      .on(t.lockedAt)
      .where(sql`${t.state} = 'running'`),
  ],
);

/** Fixed-window counters for rate limiting. Atomic upsert, no external store. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index('rate_limits_window_idx').on(t.windowStart),
  ],
);

/**
 * Single-row counter for gap-free order numbers. A sequence would leave gaps on rollback;
 * incrementing this row inside the order's transaction does not (the lock serialises creators,
 * a rollback undoes the increment).
 */
export const orderCounter = pgTable(
  'order_counter',
  {
    id: integer('id').primaryKey().default(1),
    last: integer('last').notNull(),
  },
  (t) => [check('order_counter_single_row', sql`${t.id} = 1`)],
);
