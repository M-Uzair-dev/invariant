# Invariant

A small payment processor (a mini Stripe) built to prove one thing: **no matter what crashes, and when, money is never lost, never created, never charged twice, and the store always finds out.**

There are no real cards or banks. Balances are fake, but the system is built as if the money were real.

## How it works

- **Users** hold a balance, funded through a top-up endpoint.
- **Stores** hold a balance, a hashed secret API key, and a webhook URL.
- A store creates a payment (`POST /payments`, idempotent via `Idempotency-Key`). The user approves it on a hosted checkout page. Money moves from the user to the store in a single Postgres transaction, and the store is notified by a signed webhook.

Webhooks go through a **transactional outbox**. The event row is written in the same transaction as the money movement, and a separate worker delivers it with at-least-once semantics, retries, and a dead-letter state. Stores can also poll `GET /payments/:id` as a fallback.

## Invariants

Every test and every code change is checked against these:

1. **Conservation:** all ledger entries sum to zero.
2. **Balances match the ledger:** each cached balance equals the sum of its entries.
3. **At most once:** a payment is charged at most once, however many approvals arrive.
4. **Double entry:** every succeeded payment has exactly one debit and one credit.
5. **No overdraft:** a user balance never goes negative.
6. **Legal transitions only:** `pending → succeeded | failed | expired`, and terminal states are final.
7. **Every status change owes a webhook:** the outbox event is written in the same transaction.
8. **Idempotency:** the same key returns the original response, and the same key with a different body is rejected.

## Roadmap

- [ ] **Phase 1: money moves correctly.** Accounts, top-ups, API keys, idempotent payment creation, approval, and the ledger, with concurrency tests.
- [ ] **Phase 2: stores find out reliably.** Outbox, delivery worker, retries, dead letter, replay, signing, and expiry.
- [ ] **Phase 3: prove it survives failure.** Reconciliation plus chaos tests that kill the process mid-approval and mid-delivery.
- [ ] **Phase 4: fix the hot row.** Load test many users paying one store, and remove the contention on the store's balance row.
- [ ] **Phase 5 (optional): go distributed.** Split services and add tracing.

## Stack

NestJS · TypeScript · PostgreSQL · Prisma 7 (pg driver adapter) · Redis · BullMQ · Jest

## Running locally

Requires Node.js and Docker.

```bash
docker compose up -d          # Postgres (dev :5432, test :5433) and Redis (:6379)
npm install
```

Create a `.env` file:

```
DATABASE_URL=postgresql://invariant:invariant@localhost:5432/invariant
REDIS_HOST=localhost
REDIS_PORT=6379
```

Then:

```bash
npx prisma generate
npm run start:dev
```

Tests:

```bash
npm test          # unit
npm run test:e2e  # end to end
```

## Author

Uzair Manan · [uzairmanan3@gmail.com](mailto:uzairmanan3@gmail.com)
