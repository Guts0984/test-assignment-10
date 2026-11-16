# Online shop: cart, checkout, orders

Customers fill a cart, check out, pay (through a **payment stub** that behaves like a real provider), cancel, or return part of an order.
Managers maintain products, stock and promo codes, ship orders and watch sales.

```
apps/api         NestJS (the only place with classes: Nest requires them)
apps/web         Next.js 15 (App Router), Feature-Sliced Design, shop + manager area
apps/e2e         Playwright tests against the running stack
packages/shared  Zod schemas, types, pure money / promo functions (used by api AND web)
packages/db      Drizzle schema + migrations, atomic DB primitives, seed, DB tests
docker/          Dockerfiles, nginx.conf
scripts/         smoke test of the composed stack (attacker + victim containers)
```

## Run

```bash
cp .env.example .env
docker compose up --build
```

That is the only manual step: migrations and the seed run automatically when the `api` container starts (the seed is skipped if the database already has data).

| URL                        | What                                                |
| -------------------------- | --------------------------------------------------- |
| http://localhost:8080      | the shop (nginx -> web / api)                       |
| http://localhost:8080/docs | Swagger UI (also `/docs-json`)                      |
| `localhost:5433`           | PostgreSQL (`POSTGRES_HOST_PORT`)                   |

The web (3000) and api (4000) containers are **not** published to the host: nginx is the only entry point, so every request passes its rate limits, body-size cap and header overwrite (`/api/*` goes to the api, everything else to the web). Ports are configurable in `.env` (`NGINX_HOST_PORT`, `POSTGRES_HOST_PORT`).

**Demo logins** (created by the seed; passwords come from `.env`):

| Role     | Login                                          | Password       |
| -------- | ---------------------------------------------- | -------------- |
| manager  | `manager@shop.test`                            | `Manager123!`  |
| customer | `customer1@shop.test` … `customer50@shop.test` | `Customer123!` |

Seeded promo codes: `WELCOME10` (10 %, once per customer), `BIG7` (7 %, min 3 000 ₴), `SAVE500` (500 ₴, min 4 000 ₴), `ONLYONE` (15 %, total limit 1 - handy to try the "two buyers, one discount" race), `EXPIRED5` (expired), `NEXTYEAR` (not started).

### Tests

```bash
pnpm install
docker compose up -d postgres        # tests use a REAL PostgreSQL (each test file creates its own database)
pnpm lint && pnpm typecheck && pnpm test
./scripts/smoke-compose.sh           # needs `docker compose up -d`: hostile client against nginx
pnpm --filter @shop/e2e install:browsers && pnpm --filter @shop/e2e e2e   # Playwright against http://localhost:8080
```

`TEST_DATABASE_URL` (see `.env.example`) points tests at the compose PostgreSQL. CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck and all unit/integration tests on every commit against a PostgreSQL service container, and a second job boots the compose stack and runs the smoke test and the e2e suite.

What the suites cover:

- **packages/shared** - money rounding as property tests (sums always exact), promo reasons, schemas against hostile input.
- **packages/db** - constraints, atomic primitives under concurrency, job queue with competing workers, the seed's integrity (every order's money adds up), query speed on 10 000 orders.
- **apps/api** (real server, real sockets, real PostgreSQL): permissions matrix, IDOR, brute force and flooding from several source addresses, malformed input (always 4xx), the last item / limited promo / double submit / 50 parallel order numbers, reservation expiry with a fake clock, webhook (repeat ×25 in parallel, bad / stale / tampered signature, late, after timeout), cancel-vs-payment races, returns to the kopeck.
- **apps/web** (Vitest + Testing Library): totals, promo refusal reasons, address form, return form, URL filters, locale formatting and plurals, translations parity.
- **apps/e2e** (Playwright): cart → checkout → pay on the stub → status changes without reload; late notification; cancel; partial return; locales; manager flows.

## Money and rounding

- All amounts are **integer kopecks** (DB columns, API, shared functions). The UI converts only for display; input like `12,50` is parsed with string arithmetic, never floats.
- **Delivery**: pickup 0; courier 100 ₴, free when the amount **after the discount** is ≥ 2 000 ₴ (`FREE_DELIVERY_FROM_KOPECKS`).
- **Promo discount**: percent → `floor(subtotal × p / 100)`; fixed → `min(value, subtotal)`. An order whose total would become 0 is refused (a payment of 0 cannot exist).
- **Distribution over lines** (`allocateByWeights`, largest remainder method): every line gets `floor(discount × lineSubtotal / subtotal)`; the leftover kopecks go one each to the lines with the largest fractional remainders (ties → lower index). Properties, tested: the shares sum to the discount **exactly**, no share is negative or above its line, a zero-priced line gets nothing.
  Example (7 %, lines 33.33 ×1, 19.99 ×3, 123.45 ×2): subtotal 340.20, discount 23.81 → shares 2.33 / 4.20 / 17.28.
- **Refund of returned goods**: the line's net value is `qty × price − its discount share`. Returning `k` of `qty` units refunds `cumulative(k) − cumulative(already returned)`, with `cumulative(k) = floor(net × k / qty)` and `cumulative(qty) = net`. Because it is cumulative, several partial returns add up to the line's net **exactly**. **Delivery is never refunded.**
- Cancelling a paid order refunds the whole paid amount (including delivery).
- Totals shown in the UI come from the same server calculation: the cart API returns subtotal / discount / courier fee, checkout sends `expectedTotal`, and the server refuses (`total_mismatch`) if it would charge something else.

## Reservation (15 minutes) and its release

- "Place order" runs **one transaction**: per-customer advisory lock → idempotency lookup → `SELECT … FOR UPDATE` of the products (in id order, so no deadlocks) → guarded `UPDATE products SET stock = stock - q WHERE stock >= q` (plus a `CHECK (stock >= 0)`) → price check → promo redemption → totals → order number → insert. `products.stock` is the **sellable** stock: the reservation is the decrement itself.
- The order gets `reserved_until = now + 15 min` and a row in the PostgreSQL job queue (`expire_order`, `run_at = reserved_until`).
- The worker (inside the api, `JOBS_POLL_MS`) claims due jobs with `FOR UPDATE SKIP LOCKED`, so any number of api instances can run it without double work; a job stuck in `running` is re-claimed after 2 minutes; failures retry with exponential backoff, up to 8 attempts.
- `expire_order` locks the order and, if it is still `awaiting_payment` and past its deadline, sets `cancelled / expired`, returns the stock and the promo use. Running it twice is harmless.
- All time comes from an injected clock, so tests move time instead of sleeping. The queue is `runDueJobs(ctx)`.
- Not enough stock → no order; the response lists every product with `requested` and `available`. A price that changed since the customer saw it → `price_changed`; the cart marks the line, the customer confirms (`POST /cart/accept-prices`) and only then can check out.
- A customer can hold at most `MAX_PENDING_ORDERS` (5) unpaid orders, otherwise one account could reserve the whole stock for 15 minutes at a time.

## Payment stub and its notifications

- `POST /orders/:id/pay` creates (or reuses) a payment session and returns `{ paymentId, url }`; the URL is the stub page of the web app (`/stub/pay/:id`) with three buttons: **Success**, **Declined**, **Success, but the notification arrives in 30 seconds**. The page is only a UI: it calls the api (`/stub/payments/:id/complete`) and the **stub inside the api** then behaves like a provider and notifies the shop with `POST /payments/webhook`.
- The notification is a JSON event (`payment.succeeded`, `payment.failed`, `refund.succeeded`) signed with **HMAC-SHA256** in `X-Signature: t=<unix>,v1=<hex>` over `"<t>.<raw body>"`. The api verifies it over the **raw bytes**, in constant time, rejects timestamps older/newer than `WEBHOOK_TOLERANCE_SECONDS` (replay), and answers `401` before parsing anything. Bad signatures are counted per IP and throttled (`429`) - a valid signature is never blocked.
- "In 30 seconds" is a queued job (`deliver_webhook`, `run_at = now + STUB_DELAY_SECONDS`). If the shop is unreachable, delivery is retried with backoff.
- **Idempotency**: every event has an `eventId`. The processing transaction first inserts it into `payment_events` (primary key). A second delivery inserts nothing and returns `{status:"duplicate"}` - the insert and the state change are in the same transaction, so a crash cannot leave an event half-applied. On top of that, a **new** event id for a payment that is already booked as paid changes nothing, and a second _payment_ for an already-paid order is refunded automatically (`duplicate_payment`). Clicking the stub's button repeatedly sends the same deterministic event id.
- **Refunds** also go through the stub: the shop records a `refund` (pending) and queues a `refund.succeeded` notification; when it arrives the refund becomes `succeeded` with a timestamp. The order page shows amount, kind, time and state (and keeps refreshing while one is pending).

### A late notification (after the timeout)

When `payment.succeeded` arrives for an order that was cancelled **by the timeout**:

1. the stock is reserved again (all-or-nothing, same locking) and the promo use is re-acquired;
2. if both work → the order is **restored to `paid`**; history: `expired → restored_after_late_payment`;
3. if the goods are gone (or the promo can no longer be used at the price that was charged) → the money is **refunded automatically**, the order stays `cancelled`; history: `expired → refund_requested → auto_refunded_late_payment (reason) → refund_succeeded`.

If the **customer** cancelled the order on purpose, a payment arriving afterwards is refunded, never resurrected.

## Cancel vs. payment

Every state change - cancel, expiry, webhook, status change, return - starts with `SELECT … FOR UPDATE` on the **order row**, so they are serialised. Whatever the order of two concurrent requests:

- payment first → the order is `paid`, then the cancellation sees `paid`, cancels and creates the refund;
- cancel first → the order is `cancelled (customer)`, then the notification sees that and creates the refund.

Both end as "cancelled **with** a refund of the money received", never "cancelled without a refund". A test repeats this race 30 times in both orders and 15 times for the timeout, asserting exactly that.

## Order statuses

| From               | To                 | Who                  | Rule                                                                                 |
| ------------------ | ------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| (new)              | `awaiting_payment` | customer             | stock reserved for 15 min                                                            |
| `awaiting_payment` | `paid`             | payment notification | signed webhook                                                                       |
| `awaiting_payment` | `cancelled`        | customer / worker    | cancel, or timeout; stock and promo use return                                       |
| `cancelled`        | `paid`             | late notification    | only after a **timeout**, only if goods and promo are still available (else refund)  |
| `paid`             | `shipped`          | manager              | `PATCH /orders/:id/status`                                                           |
| `paid`             | `cancelled`        | customer             | full refund, stock and promo use return                                              |
| `shipped`          | `delivered`        | manager              | `PATCH /orders/:id/status`                                                           |
| `delivered`        | `delivered`        | customer             | partial **return** within 14 days (`RETURN_WINDOW_DAYS`); the status does not change |

Everything else is `409 invalid_transition`. After `shipped` the customer can no longer cancel. Returned goods go back on the shelf.

## Concurrency guarantees

| Scenario                               | Mechanism                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| last unit, two buyers                  | row locks + guarded decrement + `CHECK (stock >= 0)`; the loser gets the shortage list                                              |
| promo with limit 1, two buyers         | promo row lock + `UPDATE … WHERE used < max_uses` + `CHECK (used <= max_uses)`; per-customer partial unique index                   |
| double click / dropped connection      | client `Idempotency-Key` (UUID) + per-customer advisory lock + unique `(user_id, idempotency_key)`                                  |
| order numbers                          | single-row counter incremented **inside** the order's transaction: a rollback gives the number back (a `SEQUENCE` would leave gaps) |
| duplicate / parallel notifications     | `payment_events` primary key in the processing transaction                                                                          |
| cancel vs. payment, expiry vs. payment | order row lock (see above)                                                                                                          |
| two return requests for the same goods | order row lock + `returned_qty <= qty` check                                                                                        |

A promo code is _applied_ to the cart only as a preview; it is _redeemed_ at checkout. Two customers can both apply `ONLYONE`, only one gets the discount, the other receives `promo_rejected / limit_reached` and nothing is reserved.

## Security

- Sessions: random 256-bit token in an `httpOnly; SameSite=Lax` cookie (`Secure` with `COOKIE_SECURE=true`); only an **HMAC of the token** is stored. Passwords: scrypt (Node built-in, constant-time compare; malformed hashes never verify).
- Authorisation on the server for every route (global guard, `@Roles`). A customer asking for someone else's order gets `404` (indistinguishable from a missing one). Managers cannot shop.
- **Login throttling**: counters in PostgreSQL, taken atomically **before** the password is checked: per IP (`LOGIN_MAX_PER_IP`) and per **IP + account** (`LOGIN_MAX_PER_IP_ACCOUNT`). There is deliberately no per-account counter - guessing a password from another machine cannot lock the owner out. Unknown e-mails cost the same time as wrong passwords.
- Global per-IP request limit (`API_RATE_MAX_PER_IP`). The client address comes from `X-Forwarded-For` **only** when `TRUST_PROXY_HOPS` says a proxy is in front, taking the entry written by the nearest trusted proxy (counted from the right); nginx overwrites the header with the address it really saw, so forged values are ignored.
- CSRF defence in depth: `Origin` must be one of `ALLOWED_ORIGINS` on state-changing requests. No CORS headers at all (same origin through nginx / the Next.js rewrite).
- Errors never leak internals; every response carries `X-Request-Id`. Bodies are JSON only, `BODY_LIMIT_KB`, 4xx for anything malformed.
- nginx adds an edge layer: per-IP request limits for `/api/`, a tighter one for login, connection limits, body size and slow-client timeouts.

## Indexes (and why)

| Index                                                                                      | Serves                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `orders (status, created_at desc, id desc)`                                                | manager list filtered by status, newest first, keyset paging |
| `orders (created_at desc, id desc)`                                                        | manager list without a status                                |
| `orders (user_id, created_at desc, id desc)`                                               | "my orders"                                                  |
| `orders (paid_at) WHERE paid_at IS NOT NULL`                                               | sales report for a period                                    |
| `orders (reserved_until) WHERE status = 'awaiting_payment'`                                | what is waiting for expiry                                   |
| unique `orders (number)`, `(user_id, idempotency_key)`                                     | numbering, idempotent checkout                               |
| `order_items (order_id)`, `(product_id)`                                                   | order details, top products                                  |
| `order_events (order_id, seq)`                                                             | history in the order things happened                         |
| `products (category_id, price)`, `(price, id)`, `(name, id)`, `(created_at desc, id desc)` | filter by category/price, keyset paging for every sort order |
| partial unique `promo_redemptions (promo_id, user_id) WHERE once_per_customer`             | one use per customer                                         |
| `jobs (run_at) WHERE state = 'pending'`, `(locked_at) WHERE state = 'running'`             | the worker's poll                                            |
| `rate_limits (key, window_start)` (PK), `(window_start)`                                   | atomic counters, cleanup                                     |

On the seed (10 000 orders / 90 days) the manager's filtered order list answers in ~10 ms and the 90-day report in ~20 ms (the tests assert < 300 ms for both, through HTTP).
Product search uses `ILIKE '%…%'`: fine for 500 products; for a large catalogue add a `pg_trgm` GIN index.

## Decisions on things the assignment leaves open

- **Where reservation lives**: `products.stock` is the sellable quantity; reserving = decrementing, releasing = incrementing (no separate "reserved" column to keep in sync).
- **A customer cancelled → late payment** is refunded (see above); only an **expired** order can be restored.
- **Promo redeemed at checkout, not at "apply"** (see Concurrency). A promo that stops being valid between cart and checkout → `promo_rejected` with the reason.
- **Order that a promo would make free** is refused; free orders have no payment to track.
- **Price confirmation**: the cart keeps the price the customer saw (`price_seen`); a changed price is flagged, shown as old → new, and checkout is refused until confirmed.
- **Customers' product visibility**: inactive products are hidden from customers (and cannot be bought); "delete" in the manager UI hides, because order lines reference products.
- **Report**: counts orders `paid / shipped / delivered` whose payment happened in the period (UTC days, both ends inclusive); revenue = their totals − everything refunded on them (returns); orders cancelled after payment are fully refunded and therefore not counted; average order = revenue / orders (floored).
- **Returned goods are restocked.**
- **Language of the stub page** follows the locale prefix the customer came from.
- Seeded orders that are `awaiting_payment` (10 of them, created in the last 10 minutes) really expire 15 minutes after the seed through the normal job.
- One api instance polls jobs every second; running several is safe, polling load is one indexed query per instance per second.

## Known limits

- Without a Redis-like store the per-IP counters are PostgreSQL upserts: one small write per API request. Fine here; for very high traffic the edge (nginx) limit should absorb floods first (it does) and counters could move in-memory per instance.
- Behind Docker Desktop / userland proxy every local client can appear with the bridge's address, so the per-IP limits then act on that single address; with real clients (or separate containers, as in `scripts/smoke.mjs`) addresses are distinct.
- The password limiter protects against guessing from one address; a botnet using thousands of addresses against one account is not stopped by design (the alternative - locking the account - lets anyone lock the owner out).
