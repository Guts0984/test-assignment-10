# plan.md — Online store (cart, checkout, orders)

Source of truth: `test-assignment-10.md`. If anything here conflicts with it, the assignment wins.

## 0. Conflicts / decisions to confirm

| # | Your note | Assignment | Decision |
|---|-----------|-----------|----------|
| 1 | "redis" block | Redis forbidden; background jobs and everything else on PostgreSQL | **No Redis.** Rate limiter state, job queue, and order-number sequence all live in PostgreSQL. |
| 2 | "nginx" block | Not mentioned (compose = `postgres`, `api`, `web`) | Nginx is **optional**, added as a reverse proxy in front of `api`+`web` (single origin => cookie works without CORS; real client IP via `X-Forwarded-For`). Compose still brings up `postgres`, `api`, `web` (+`nginx`). Acceptance #1 still holds. |
| 3 | "classes only for NestJS" | Nothing | Classes only for Nest modules/controllers/providers/guards/filters. All else (repos, services' pure logic, money math, web code) = plain functions + modules. Nest classes are thin adapters that call pure functions. |
| 4 | "git commits, I push" | "CI on every commit, last commit green" | I `git init` and commit; **every block commit must pass lint+typecheck+its own tests** so CI is green per commit. |
| 5 | env | "Secrets not in code", only manual step `cp .env.example .env` | `.env.example` holds **every** variable (dev-safe placeholder values for secrets, clearly marked). `apps/api/src/env.ts` parses with Zod; non-sensitive vars have defaults, secrets (`SESSION_SECRET`, `WEBHOOK_SECRET`, `DATABASE_URL` password) are required, no default. |

## 1. Repo layout

```
.
├─ apps/
│  ├─ api/            NestJS (classes only here)
│  └─ web/            Next.js 15, Feature-Sliced Design
├─ packages/
│  ├─ shared/         Zod schemas + inferred types + pure money/promo calc (used by api AND web)
│  └─ db/             Drizzle schema, migrations, seed, db client, repositories (functional)
├─ docker/            Dockerfiles, nginx.conf, entrypoints
├─ docker-compose.yml
├─ .env.example
├─ .github/workflows/ci.yml
├─ plan.md  README.md
```
pnpm workspaces. TypeScript strict everywhere. ESLint bans `any`, `@ts-ignore` w/o description (`ban-ts-comment` with `allow-with-description`), and `class` outside `apps/api` (`no-restricted-syntax` on `ClassDeclaration`).

## 2. Architecture rules

- **Money**: integer kopecks (`bigint`-free, `integer`/`number` safe range). Pure functions in `packages/shared/money`: `calcTotals`, `allocateDiscount`, `calcDelivery`, `calcRefund`.
- **Rounding**: discount allocated by **largest remainder method** (floor each line's share, hand leftover kopecks to lines with largest fractional remainder, tie → lower line index). Sum of lines == total discount exactly. Refund of a line = line net (after discount share) × qty_returned / qty_bought, with the same remainder rule so repeated partial returns sum to the exact line net (last return gets the remainder). Delivery never refunded. Documented in README.
- **Free delivery** threshold: subtotal after discount ≥ 200000 kop.
- **Web = FSD**: `app/ (Next routes, thin) → pages-layer → widgets → features → entities → shared`. Imports only downward; enforced with `eslint-plugin-boundaries`/`import/no-restricted-paths`. Next `app/` dir only re-exports FSD pages. Functional components + hooks, no classes.
- **API modules** (Nest): `auth, users, products, cart, promo, orders, payments(webhook), stub-provider, reports, jobs, rate-limit, health`. Each controller → pure service functions → repositories from `packages/db`. Zod pipe validates with `packages/shared` schemas. Single error filter → `{ error: { code, message, details?, requestId } }`; unknown input never 5xx.
- **Transactions & concurrency** (all in PostgreSQL):
  - last item: `UPDATE products SET stock = stock - $q WHERE id=$1 AND stock >= $q` (atomic, plus `CHECK (stock >= 0)`).
  - promo limit: `UPDATE promo SET used = used + 1 WHERE id=$1 AND (max_uses IS NULL OR used < max_uses)`; per-customer uniqueness via `UNIQUE (promo_id, customer_id)` in `promo_redemptions`.
  - idempotent checkout: client `Idempotency-Key` (UUID) → `UNIQUE (customer_id, idempotency_key)` on orders; replay returns the same order.
  - order number: DB `SEQUENCE` gives uniqueness but **gaps on rollback** → use a one-row counter table `order_counter` updated with `UPDATE … RETURNING` **inside the order transaction** (row lock serialises; rollback undoes increment ⇒ no gaps). Start at 10234.
  - cancel vs pay: both take `SELECT … FOR UPDATE` on the order row, then branch on current status; payments recorded in `payments` table with `UNIQUE(provider_event_id)` for webhook idempotency.
- **Background jobs on PG**: `jobs` table + worker loop in api using `SELECT … FOR UPDATE SKIP LOCKED`. Jobs: `expire_reservation` (scheduled at `run_at = created+15m`), `deliver_delayed_webhook` (stub 30s), `refund`. Clock injected (`Clock` function param) so tests fake time; `runDueJobs(now)` exported and callable from tests.
- **Rate limiter on PG** (no Redis): table `login_attempts(key, window_start, count)` with atomic `INSERT … ON CONFLICT DO UPDATE`. Two independent buckets: `ip:<ip>` (e.g. 20 fails/15m) and `ip+account:<ip>:<email>` (e.g. 5 fails/15m). **No per-account-only bucket** → attacker from another IP can't lock owner out. Also a general per-IP request limiter for the API. Real IP via trusted-proxy config (`TRUST_PROXY_HOPS` env), never raw `X-Forwarded-For` from the client. Password hashing: argon2 (or scrypt from node crypto to avoid native dep — decide at impl).
- **Sessions**: opaque random token, stored hashed in `sessions` table, `httpOnly; SameSite=Lax; Secure(in prod)` cookie. CSRF: SameSite + `Origin` check on mutating requests.
- **Webhook**: `POST /payments/webhook`, HMAC-SHA256 over raw body + timestamp header, `timingSafeEqual`, tolerance window, reject missing/bad sig with 401 before parsing. Event `{eventId, orderId, type: payment.succeeded|payment.failed|refund.succeeded, amount}`. Idempotent by `eventId`.
  - paid on `awaiting_payment` → `paid`.
  - paid on `cancelled`: in one tx try to re-reserve stock; success → `paid` + history "restored"; failure → create refund via stub + history "auto-refunded".
  - duplicate → 200 no-op.
- **Stub provider** (inside api, module `stub-provider`): `POST /orders/:id/pay` creates payment session, returns `/stub/pay/:sessionId` (page served by web: 3 buttons). Buttons call stub API → stub signs and POSTs webhook to api (immediately, or via `jobs` with `run_at = now+30s`). Refunds go through the same stub and come back as webhook.
- **Order history**: `order_events` table (created, paid, restored_after_cancel, auto_refunded, cancelled, shipped, delivered, return_requested, refunded …) → shown in UI.

## 3. Status transitions (also in README)

| From | To | Who | Condition |
|------|----|-----|-----------|
| (new) | awaiting_payment | customer | stock reserved 15 min |
| awaiting_payment | paid | webhook | signature ok |
| awaiting_payment | cancelled | customer / job | cancel or 15 min timeout; stock + promo use released |
| cancelled | paid | webhook (late) | stock still available |
| cancelled | cancelled + auto-refund | webhook (late) | stock gone |
| paid | shipped | manager | |
| paid | cancelled | customer | money refunded, stock + promo returned |
| shipped | delivered | manager | |
| shipped / delivered | — | — | no cancel after shipped; returns after delivered ≤ 14 days |
Everything else → `409`.

## 4. Data model (Drizzle, `packages/db`)

`users(id, email unique ci, password_hash, role)`, `sessions`, `categories`, `products(id, name, category_id, price, stock, reserved?, active)` , `carts`, `cart_items(cart_id, product_id, qty, price_seen)`, `promo_codes(code citext unique, type, value, min_order, starts_at, expires_at, max_uses, used)`, `promo_redemptions`, `orders(…, number unique, idempotency_key, status, subtotal, discount, delivery, total, reserved_until, delivery_method, address jsonb)`, `order_items(price_at_order, qty, discount_share, returned_qty)`, `order_events`, `payments`, `refunds`, `returns`+`return_items`, `jobs`, `login_attempts`, `order_counter`.
Indexes (justified in README): orders `(status, created_at desc)`, `(customer_id, created_at desc)`, `(reserved_until) WHERE status='awaiting_payment'`; order_items `(order_id)`, `(product_id)`; products trigram/GIN on name, `(category_id, price)`, cursor `(created_at,id)`; jobs `(run_at) WHERE state='pending'`; sales report served by `(created_at)` partial on paid-ish statuses.
Seed: 10 categories, 500 products, 50 customers, 1 manager, 10 000 orders / 90 days / all statuses with consistent items+events+payments, several promos. Deterministic (seeded PRNG). Bulk inserts so it runs in seconds.

## 5. Commit blocks (each = complete, tested, CI-green, modular)

Each block is **end to end**: code + its Dockerfile/compose service where relevant + its tests + docs in README section. I commit the block, stop, and you verify before the next one.

1. **chore: monorepo skeleton + tooling** — pnpm workspaces, tsconfig strict, ESLint rules (no any, no class outside api, FSD boundaries later), Prettier, Vitest config, `.env.example` (full), CI workflow (lint, typecheck, test w/ postgres service), `.gitignore`, `git init`.
2. **db: PostgreSQL layer** — `packages/db`: Drizzle schema, migrations, client, repositories, seed, `docker/postgres` + compose `postgres` service with healthcheck, migrate+seed entrypoint script. Tests on **real PG** (testcontainers or compose PG): constraints (stock ≥ 0, unique promo redemption, idempotency key, order counter under 50 concurrent txs → no gaps), migrations up from empty, seed counts/integrity (sum(items)=totals, statuses all present), query-speed assertions (<300 ms orders list, report 90d). *You can verify DB alone: `docker compose up postgres`.*
3. **shared: Zod schemas + pure money/promo logic** — schemas, types, `calcTotals`, `allocateDiscount`, `calcRefund`, promo validation reasons. Unit tests incl. property-style (random cents: sum always exact; 7% on 3 lines; repeated partial refunds sum to net).
4. **api-core: env.ts, Nest bootstrap, error format, Swagger `/docs`, auth/sessions, roles guard, PG rate limiter, trusted-proxy IP, health** + `apps/api/Dockerfile` + compose `api` service. Tests: supertest on **real running server + real PG**; **adversarial suite**: credential-stuffing from IP A against victim doesn't block victim on IP B; one IP spamming trips IP bucket but other IPs are untouched; spoofed `X-Forwarded-For` ignored; brute force timing; cookie flags; session fixation/logout invalidation; malformed/oversized/huge-unicode/prototype-pollution JSON → 4xx never 5xx; RBAC matrix for every route (customer vs manager vs anon); IDOR on others' orders.
5. **api-shop: products, cart, promo, orders, reservation, jobs worker, stub provider, webhook, cancel, returns, status, reports** (may be split in two commits if too large: 5a catalog+cart+promo, 5b orders+payments+jobs). Tests (real PG, concurrent requests via `Promise.all` against real HTTP server): last item, promo limit 1, double submit idempotency, 50 parallel checkouts → contiguous numbers, reserve expiry with fake clock, webhook ×3 / bad sig / missing sig / replay with altered body / late / after-timeout (restore vs auto-refund), cancel-vs-pay race looped N times (invariant: never cancelled w/o refund), 7% × 3 items partial return to the kopeck, delivery thresholds, 14-day return window, over-return, status table 409s, perf <300 ms on seed.
6. **web: Next.js app (FSD)** — i18n `uk`/`en` (next-intl, ICU plurals, `Intl` money/dates), catalog (URL filters), cart (price-change confirm, stock warnings, promo reasons), checkout (RHF+Zod, reservation timer), orders (history, cancel, return form), stub payment page, polling/SSE-less auto-refresh via TanStack Query refetch, manager area (products, orders table, promos, sales report with period in URL), keyboard accessibility, `apps/web/Dockerfile` + compose `web`. Tests (Vitest+RTL): totals calc matches shared, promo reason messages, address form, return form, plural/locale formatting.
7. **nginx + compose integration** — `docker/nginx.conf` (single origin, proxy `/api` → api, `/` → web, forwards real IP, own coarse rate-limit `limit_req` layer), full `docker compose up --build` from `cp .env.example .env`, healthchecks/depends_on, migrations+seed auto. Tests: smoke script against the composed stack, including malicious-client run through nginx (flooder vs normal user keep working, header spoofing).
8. **e2e + README + CI polish** — Playwright: cart→checkout→pay→status updates w/o reload; late webhook (30 s button, fake/short delay via env); cancel; partial return; locale switch; manager flows. README (run, tests, money & rounding, reservation, webhook idempotency, cancel-vs-pay, status table, indexes, decisions). CI runs everything.

≈ 8–9 commits. I will **stop after writing this plan and wait for your review**; after approval I do block 1, commit, and then continue block by block — pausing for you after each (tell me if you'd rather I run through several blocks without stopping).

## 6. Testing philosophy

- Tests try to break things: concurrency (`Promise.all` with N=50–200), replay, tampering, boundary kopecks (1 kop remainders, 0-price, qty at stock limit), time-travel via injected clock, malformed input fuzz.
- **Security tests run a real server on a real port with real PG** and drive it with raw HTTP from several distinct source IPs (loopback aliases `127.0.0.x` / trusted-proxy header from a simulated proxy) to verify: attacker flooding doesn't deny service to others; per-account brute force from other IP doesn't lock owner; limits reset after window (fake clock).
- Each block is verifiable in isolation (db alone, shared alone, api against PG alone, web against mocked API) so a failure localises to one module.
- When a test finds a bug, fix it and keep the test.

## 7. Open questions (I'll use defaults below unless you say otherwise)

1. Package manager: **pnpm**. 2. Password hashing: **argon2** (fallback scrypt if native build is painful in Docker). 3. Delivery fee 100 ₴ = 10000 kop. 4. Login limits: 5 fails / 15 min per IP+account, 30 fails / 15 min per IP. 5. Auto-refresh of order status: TanStack Query polling every 2 s on pending orders (no websockets). 6. Seeded passwords documented in README (`manager@shop.test / Manager123!`, `customerN@shop.test / Customer123!`).
