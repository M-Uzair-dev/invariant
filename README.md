# Invariant

A small payment processor, roughly a miniature Stripe. Stores create payments, users approve them, money moves between balances in a double-entry ledger, and stores get a signed webhook for every outcome.

The balances are fake. The engineering isn't: the point of the project is to show that money is never lost, never created, never charged twice, and that the store always finds out, even when the process is killed with `SIGKILL` in the middle of any of it. There is a test suite that does exactly that.

**NestJS · TypeScript · PostgreSQL · Prisma 7 · Redis · Vitest**

## How a payment flows

1. The store calls `POST /payments` with its API key and an `Idempotency-Key`. A retried request returns the original payment instead of creating a second one.
2. The user approves it with `POST /payments/:id/approve`, authenticated by a session cookie and a 6-digit approval PIN.
3. One Postgres transaction marks the payment `SUCCESS`, debits the user, writes the ledger transfer, writes a webhook event to the outbox, and credits the store. All of it commits or none of it does.
4. A background worker delivers the outbox event to the store's webhook URL, signed with HMAC-SHA256, retrying with backoff until the store answers 2xx.
5. Payments nobody approves expire. Expiry writes its own outbox event in the same transaction, so the store hears about those too.

## The invariants

These are the rules the system is built around. Each one is enforced by the database or a transaction, not by hoping the code is right, and each one is checked after every test that moves money.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Money is only moved: all balances sum to zero | Every transfer debits and credits in one transaction. Top-ups come from a SYSTEM account that is allowed to go negative |
| 2 | Each cached balance equals its ledger (credits minus debits) | Balance updates happen in the same transaction as the transfer row; the reconciliation job verifies it |
| 3 | A payment is charged at most once | Conditional `UPDATE ... WHERE status = 'PENDING' AND "expiresAt" > now()`; 0 rows updated means someone else won, and the transaction stops |
| 4 | A succeeded payment has exactly one transfer | `UNIQUE (paymentId)` on transfers, plus a reconciliation check for "exactly one" |
| 5 | No user or store balance goes below zero | Conditional debit (`WHERE balance >= amount`) plus a `CHECK` constraint as a backstop |
| 6 | Status only moves `PENDING → SUCCESS` or `PENDING → EXPIRED` | Every status change is a conditional update from `PENDING` |
| 7 | Every succeeded or expired payment has exactly one webhook event | The event is inserted in the same transaction as the status change (transactional outbox), `UNIQUE (paymentId)` on events |
| 8 | Same idempotency key, same answer; same key with a different body is rejected | Unique indexes on the keys plus a stored hash of the original request |

Nine `CHECK` constraints and two partial unique indexes back these up at the schema level (for example, "a store can't have two active payments for one `orderId`", but can create a new one after the old one expires).

## Design notes

**Locking order in approve.** The store's balance row is the hottest row in the system, since every customer of that store touches it. Approve credits it last, so the lock is held for as short a time as possible, and the order is the same everywhere to avoid deadlock cycles. No network calls happen inside a money transaction.

**Webhook delivery is a lease-based outbox worker.** Workers claim a batch with a conditional `UPDATE` that sets `lockedUntil = now + 60s`, and only send the rows that update returned. That `lockedUntil` value is also a fencing token: every write-back is conditional on it, so a slow worker whose lease expired can't overwrite the row after another worker re-claimed it. A worker that crashes mid-send simply lets its lease expire and the event is picked up again. Delivery is at-least-once, and every event carries a stable `Invariant-Event-Id` so stores can drop duplicates.

**Retries and dead letters.** Backoff is `5s × 2^attempts` with ±20% jitter, capped at one hour, which gives about ten fast retries and then hourly ones. After 34 attempts (about a day) the event goes to `FAILED`, the store is flagged for an alert email in the same transaction, and the store can list failed events (`GET /webhooks/failed`, cursor-paginated) and replay them (`POST /webhooks/:id/replay`). Replay doesn't send anything itself: it puts the event back in the outbox, which stays the only delivery path.

**Webhook security.** Payloads are signed Stripe-style, `Invariant-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, so the timestamp is covered by the signature and old payloads can't be replayed. Webhook URLs are checked against private, loopback and link-local addresses (SSRF) when saved and again before every send, and redirects are refused because they would bypass that check.

**Reconciliation.** A job runs four read-only checks inside one `REPEATABLE READ` transaction, so it sees a single consistent snapshot while payments keep flowing: conservation, per-account balance against the ledger, the transfer and event counts for every payment status, and that every transfer goes in the right direction (user to store, SYSTEM to user). It reports drift with the offending ids and never tries to fix anything itself.

**Auth.** Users and stores log in with HttpOnly, `SameSite=Lax`, `__Host-` session cookies backed by Redis (sliding expiry with an absolute cap). Every non-GET session request also needs an `x-csrf` header, which a cross-site form can't send. Approving a payment or topping up also needs the approval PIN, limited to 5 wrong attempts per 15 minutes with an atomic Redis counter that fails closed if Redis can't answer. Stores call the payment API with a secret key that is stored as a SHA-256 hash.

**Rate limiting.** A sliding-window log in a Redis sorted set, updated atomically in one `MULTI`. A global per-IP limit covers every route and fails open if Redis is down; a stricter per-IP, per-route limit covers login, signup and PIN reset and fails closed.

## Testing

Everything runs against real Postgres and Redis in Docker, not mocks.

**`npm run test:e2e`: 333 end-to-end tests.** Besides the normal behavior and validation cases, they include:

- 10 concurrent approvals of one payment: exactly one succeeds
- concurrent payments that together exceed a balance: no overdraft
- two webhook workers on the same 150 events: each delivered exactly once
- a receiver that steals a lease mid-request: the late write-back is dropped
- a store endpoint that fails across many retries: the event still arrives once it recovers, with the same id
- reconciliation detecting every kind of drift the tests inject by corrupting rows directly

**`npm run test:crash`: crash recovery.** These tests run the built app as a child process and `SIGKILL` it at chosen points, then restart it and check the invariants, the reconciliation report and webhook delivery. To stop the app at an exact statement, the test holds a row lock from a separate Postgres connection so the app's transaction blocks on it, then kills the process.

| Scenario | Result |
|---|---|
| Killed during approve, after the payment was marked `SUCCESS`, the user debited and the event written, but before commit | Nothing persisted; a retry succeeds exactly once |
| Killed during a top-up, before commit | Nothing credited; retrying the same idempotency key credits exactly once |
| Killed in the middle of an expiry batch | No payment half-expired; the next run expires all of them and each gets one event |
| Killed after the store received a webhook, before it was marked delivered | Re-sent after the lease expires, with the same event id |
| 8 random kills under mixed load (payments, approvals, top-ups, expiry, deliveries with 10% failures) | Every acknowledged write survived, every retried top-up applied once, every event delivered, zero reconciliation drift |

A typical random-kill run: 218 requests, 41 cut off by a kill, 103 payments, 114 deliveries for 103 events (the 11 extra are expected at-least-once duplicates and retries).

## API

| Method | Path | Auth |
|---|---|---|
| POST | `/auth/signup-user`, `/auth/login-user` | none (rate limited) |
| POST | `/auth/signup-store`, `/auth/login-store` | none (rate limited) |
| POST | `/auth/logout` | session |
| PATCH | `/profile/name`, `/profile/password` | session |
| PATCH | `/profile/pin`, `/profile/pin/forgot` | user session |
| POST | `/account/topup` | user session + PIN + `Idempotency-Key` |
| GET | `/account/balance` | session |
| PUT | `/store/webhook` | store session |
| POST | `/payments` | store API key + `Idempotency-Key` |
| GET | `/payments/:id` | store API key |
| POST | `/payments/:id/approve` | user session + PIN |
| GET | `/webhooks/failed` | store API key |
| POST | `/webhooks/:id/replay` | store API key |

Webhook body:

```json
{
  "id": "<event id>",
  "type": "payment.succeeded",
  "createdAt": "2026-10-15T12:00:00.000Z",
  "data": { "paymentId": "...", "orderId": "...", "status": "SUCCESS", "amountCents": 300 }
}
```

## Running it

Needs Node.js 20+ and Docker.

```bash
docker compose up -d postgres redis     # dev Postgres on :5434, Redis on :6379
npm install
```

`.env`:

```
DATABASE_URL=postgresql://invariant:invariant@localhost:5434/invariant
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
INACTIVE_SESSION_TTL_SECONDS=86400
SESSION_MAX_LIFETIME_SECONDS=2592000
PAYMENTS_EXPIRY_SECONDS=900
PAYMENT_PAGE_URL=http://localhost:3001/checkout
```

```bash
npx prisma migrate deploy
npx prisma db seed            # creates the SYSTEM account
npm run start:dev
```

Tests use their own containers and `.env.test`:

```bash
docker compose up -d postgres-test redis-test   # :5433 and :6378
npm run test:e2e
npm run test:crash    # builds the app first; about 2-3 minutes
npm test              # both
```

Optional settings: `REDIS_TLS=true` (ElastiCache with in-transit encryption), `REDIS_USERNAME` / `REDIS_PASSWORD` (AUTH token or RBAC user), `WEBHOOK_WORKER_INTERVAL_MS` (0 disables the worker), `WEBHOOK_HTTP_TIMEOUT_MS`, `WEBHOOK_ALERT_INTERVAL_MS`, `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_WINDOW_MS`.

## Known limitations

These are deliberate scope cuts, listed so nobody has to discover them:

- **The hot row hasn't been load-tested.** Every payment to one store locks that store's balance row, which caps throughput per store. The planned fix is to credit stores asynchronously from the ledger, since a store balance only goes up.
- **DNS rebinding.** The SSRF check resolves the host, then `fetch` resolves it again, so a hostile DNS server could answer differently the second time. The fix is to pin the checked IP in the HTTP agent.
- **Alert emails are logged, not sent.** The mailer is an interface with a logging stub.
- **There is no checkout page yet.** Approval works through the API; the hosted page belongs in a frontend.
- **Rate limits are per IP.** Behind a proxy, Express needs `trust proxy` configured, and a distributed attack across many IPs isn't stopped by these limits alone.
- **Changing a password doesn't log out other sessions.**
- **A crash during a PIN check costs the user one attempt** (the counter is incremented before the comparison and cleared after it). It clears on the next correct PIN or after 15 minutes.

## Author

Uzair Manan · [uzairmanan3@gmail.com](mailto:uzairmanan3@gmail.com)
