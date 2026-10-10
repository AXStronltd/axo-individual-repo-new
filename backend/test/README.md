# Tests

## Unit tests (run anywhere, no services)

- `money.test.ts` — minor-unit conversion is exact; no floating-point money.
- `ledger.test.ts` — double-entry invariants: postings balance to zero, unbalanced/single-leg/non-positive postings are rejected, reversals net out without deleting the original.

```
npm test
```

These prove the core money rules and gate every commit.

## Integration tests (need Postgres + Redis)

The service functions in `src/modules/payments/payments.service.ts` are written to be exercised against a real Postgres (not mocks), because transaction semantics are the point. To run them, point `DATABASE_URL` at a disposable test database and `REDIS_URL` at a test Redis, then run migrations and the suite.

Cases to cover (from the build brief's test plan), each a direct call to the service with its own merchant + accounts set up in a `beforeEach`:

| Test | Asserts |
| --- | --- |
| charge stays pending | `createCharge` returns `status: 'pending'`; no ledger entries yet |
| confirm on webhook only | `confirmChargeFromWebhook` moves it to `confirmed` and posts the balanced legs |
| duplicate webhook | second call with the same `eventId` returns `applied: false, reason: 'duplicate_event'`; balance unchanged |
| duplicate request | two `/charges` with the same `Idempotency-Key` yield one transaction (replay the stored response) |
| idempotent confirm | confirming an already-confirmed txn returns `already_confirmed`; balance unchanged |
| reversal | `reverseTransaction` creates a linked `reversal` txn, nets the balance to zero, leaves the original row visible as `reversed` |
| integrity | `assertBalanceIntegrity` passes after every operation (cached balance == ledger sum) |

### Invoice state machine (Postgres)

| Test | Asserts |
| --- | --- |
| sequential numbers | consecutive `createInvoice` calls yield INV-000001, INV-000002, … gap-free, even concurrently |
| issue | draft → issued sets `issuedAt` |
| partial payment | a payment below the balance → `partially_paid`, a confirmed `payment_in` txn, a linked `invoice_payment`, and the merchant balance credited |
| full payment | a payment covering the balance → `paid` |
| overpay clamp | paying more than the balance applies only the balance; the excess is not recorded |
| settled guard | paying a `paid` invoice is rejected |
| cancel | cancelled invoices reject further payments |

A `docker-compose.yml` with Postgres + Redis is the simplest local setup; CI runs the same against service containers.
