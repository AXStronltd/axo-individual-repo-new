# Axo Business — POS & Payments API

How a till, POS or back office takes Axo payments: raise a **payment request** for a sale, show its QR, and learn that it was paid, either by polling or through a **signed webhook**.

> **Status:** sandbox. Everything below runs end to end against the sandbox and Postgres (`backend/test/payment-requests.e2e.test.ts`). It hasn't been run against live money. Payments between Axo wallets settle on Axo's own ledger. Getting money *into* wallets in production needs a funding rail and licensing (see `SECURITY.md`).

Base URL: wherever the backend runs (`http://localhost:4000` in development). All bodies are JSON. **Amounts are integer strings in minor units:**

| Currency | Minor unit | `"1250"` means |
|---|---|---|
| KES (also UGX, TZS, RWF, SOS) | 1 shilling (no cents) | KES 1,250 |
| USD (Somalia transacts in USD) | 1 cent | USD 12.50 |

## 1. Authenticate the till

An owner signs in to the dashboard and mints an API key for each till. The key is shown **once**; only its SHA-256 is stored.

```http
POST /api-keys
Authorization: Bearer <owner access token>

{ "name": "Front till", "role": "cashier" }
```

```json
{ "id": "…", "name": "Front till", "role": "cashier", "prefix": "3f9a1c0b2d4e", "key": "axo_sk_3f9a1c0b2d4e_…" }
```

The till then sends `X-Api-Key: axo_sk_…` on every call. A key acts as its merchant with a fixed role. `cashier` (the default) can raise, read and cancel its own requests. `manager` can also see the whole merchant's requests. A key can never be `owner`, can't mint keys, and can't change webhooks. Revoke a key with `POST /api-keys/:id/revoke`.

## 2. Raise a payment request for a sale

```http
POST /payment-requests
X-Api-Key: axo_sk_…

{
  "amountMinor": "1250",
  "saleRef": "RCPT-000481",
  "description": "2 × coffee"
}
```

`201 Created`:

```json
{
  "id": "6b0e…",
  "ref": "pr_Yx3…",
  "status": "pending",
  "amountMinor": "1250",
  "currency": "KES",
  "saleRef": "RCPT-000481",
  "targeted": false,
  "qr": "axo://pay?k=request&r=pr_Yx3…",
  "expiresAt": "2026-10-11T09:15:00.000Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `amountMinor` | yes | Positive integer string. |
| `currency` | no | Defaults to the business's currency; must be one the business holds. |
| `saleRef` | no (recommended) | Your sale/receipt id, **unique per business**. Re-sending the same `saleRef` with the same amount returns the same request (`200`). A different amount returns `409 sale_ref_conflict`. This makes "create" safe to retry after a timeout. |
| `description` | no | Shown to the customer. |
| `customerTag` / `customerWaId` | no | Targets one customer: the request is pushed to their WhatsApp and only they can pay it (the STK-push equivalent). Omit for an open QR any customer can pay. |
| `ttlSeconds` | no | 60–86400. Defaults: 15 min open, 2 min targeted. |

Show `qr` as a QR code. The QR carries **only the ref**. The amount and payee always come from the server, so editing a printed QR can't change what is charged.

## 3. The customer pays

In the Axo app the customer scans the QR (`POST /customer/scan`), sees the business name and amount, and confirms with their PIN (`POST /customer/payment-requests/:ref/pay`). A targeted request is approved by replying with the PIN on WhatsApp.

Guarantees, each covered by a test:
- A request is paid **at most once**. Concurrent or repeated submissions settle once. The payer's retry returns the original receipt; anyone else gets `409 already_paid`.
- A wrong PIN, an expired or cancelled request, or insufficient funds moves nothing.
- Marking the request paid, posting the customer ledger, posting the merchant ledger and queueing your webhook all happen in **one database transaction**.

## 4. Learn that it was paid

**Poll** (simplest):

```http
GET /payment-requests/6b0e…
X-Api-Key: axo_sk_…
```

`status` moves from `pending` to one of `paid`, `expired`, `cancelled` or `declined`. When it's `paid`, `merchantTransactionId` and `transferId` identify the payment.

**Or receive a webhook** (recommended for production). See §6.

Other calls:
- `GET /payment-requests?status=pending|paid|…&saleRef=…`: list. A cashier sees only the requests they raised.
- `POST /payment-requests/:id/cancel`: void a pending request (sale cancelled).

## 5. Refunds

```http
POST /transactions/:merchantTransactionId/refund
Authorization: Bearer <owner or accountant token>
Idempotency-Key: <unique per refund>

{ "amountMinor": "500", "reason": "one coffee returned" }
```

Omit `amountMinor` to refund whatever remains. Refunds are capped at the amount paid (`409 refund_exceeds_remaining`, then `409 already_fully_refunded`), go straight back to the customer's Axo wallet, and need an owner or accountant. Cashiers and API keys can't refund. Re-sending the same `Idempotency-Key` returns the original refund.

## 6. Webhooks

Register an endpoint (owner, signed in as a person):

```http
POST /webhook-endpoints
{ "url": "https://pos.example.com/axo/webhooks" }
```

The response includes `secret` (`whsec_…`), shown **once**. In live, the URL must be `https://`.

### Events

| `type` | When |
|---|---|
| `payment.succeeded` | A customer payment to the business posted (via a request, Till/Paybill or WhatsApp). |
| `payment.refunded` | A refund posted. |
| `payment_request.cancelled` | A pending request was cancelled. |

```json
{
  "id": "0f3c…",
  "type": "payment.succeeded",
  "createdAt": "2026-10-11T09:01:22.481Z",
  "data": {
    "transactionId": "…",
    "transferId": "…",
    "amountMinor": "1250",
    "currency": "KES",
    "customer": { "axoTag": "@amina", "displayName": "Amina" },
    "paymentRequest": { "id": "6b0e…", "ref": "pr_Yx3…", "saleRef": "RCPT-000481" },
    "confirmedAt": "2026-10-11T09:01:22.470Z"
  }
}
```

### Verifying a delivery

Each delivery is a `POST` with these headers:
- `Axo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`
- `Axo-Event-Id: <id>`

The MAC is computed over the string `"<t>.<raw request body>"` with your endpoint secret. To verify:

1. Recompute the HMAC over `t + "." + rawBody` with your secret, and compare it in constant time with `v1`.
2. Reject if `|now − t| > 300` seconds. This stops a captured delivery from being replayed later.
3. De-duplicate on `id`. Delivery is **at least once**.

Reference implementation: `verifyPayloadSignature` in `backend/src/modules/notify/outbox.lib.ts`.

### Delivery and retries

Events are written to an outbox in the same transaction as the payment, so a committed payment always produces its event. A dispatcher (running inside the API process, every 5 s) delivers them. Any non-2xx response, or no response within 10 s, is retried after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, then every 6 h. After 8 attempts the delivery is marked `failed`. `GET /webhook-deliveries` shows each delivery's state and last error.

## 7. Daily settlement report

```http
GET /reports/settlement?date=2026-10-11&currency=KES
Authorization: Bearer <owner, manager or accountant token>
```

Returns gross collections, refunds, fees (`0` — Axo charges none yet), net, payouts by status, and the closing balance for that UTC day. It also includes a **cross-ledger reconciliation**: every Axo payment and refund must have its customer-side transfer, for the same amount, completed, with both postings netting to zero. Exceptions are listed by transaction.

Axo-wallet payments settle instantly into the business's Axo balance (`settlementStatus: "settled_to_balance"`). Moving that balance to a bank is a payout (`/payouts`), which needs a live payout rail.

## Errors

Errors look like `{ "error": "<code>" }`. Statuses: `400` invalid input · `401` not authenticated · `403` role not allowed · `404` not found (or not yours) · `409` state conflict (already paid, expired, conflict) · `423` wallet locked · `503` rail or feature not configured.
