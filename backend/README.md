# Axo Business API

The backend for Axo Business — a **WhatsApp-native money network** that replaces telco wallets (M-PESA, EVC) for individuals and businesses. It is its own payment system, not an app on top of someone else's: every balance lives in Axo's double-entry ledger, and money moves between Axo users (person↔person, person↔business, payroll, suppliers) **entirely inside Axo, with no telco involved**.

**Why WhatsApp is the moat.** A customer already has WhatsApp — it works on any network, any SIM, across borders — so there is nothing to install and no line to register. That is precisely what a telco wallet can't copy: M-PESA needs a Safaricom SIM and is locked to one country; Axo reaches a Kenyan, a Somali and a diaspora sender in the same chat, and Axo-to-Axo is free.

**On-ramps — how money enters without depending on a telco.** Axo doesn't need M-PESA to work; it needs a *door* for the first top-up, and it has several that a competitor controls itself:
- **Agent network (Phase 11)** — Axo's own agents take cash and credit wallets from their float, instantly, no telco. This is how M-PESA itself bootstrapped; here it belongs to Axo.
- **Crypto** — receive USDC/USDT from anywhere, outside the telco system entirely.
- **Bank / card** — fund straight from a bank account.
- **Direct deposit** — salaries, remittances and business payouts paid *into* Axo, so money is born inside the network.
- **M-PESA (optional, transitional)** — one adapter among these, useful only while money still starts in M-PESA. Once value is in Axo it circulates without ever returning to a telco; the more it enters through the doors above, the more M-PESA becomes the thing people *leave*.

This is **Phases 1–14**: the foundation (Postgres, auth, roles), the money engine (double-entry ledger, idempotency), invoicing & collections, payouts + settlement + reconciliation, bulk payments + payroll, the customer wallet + WhatsApp money layer, cash-in/out ramps, risk & compliance, collection surfaces (QR, STK-style push-to-pay), crypto receive + global send, the remaining individual features (send-to-unregistered, reverse/recall, PIN, mini-statement), and the **agent network** on-ramp.

TypeScript · Fastify · PostgreSQL (Prisma) · Redis-ready · Vitest.

## What's built

- **Merchant onboarding** — `POST /merchants` creates a business, its owner user, and its ledger accounts.
- **Auth + server-enforced roles** — JWT login/refresh, argon2id hashing, a `requireRole` gate that the client cannot bypass.
- **Double-entry ledger** — `postLedger` writes balanced legs in one DB transaction, updates cached balances, and never deletes. Posted entries are immutable; corrections are reversals.
- **Payment workflow** — `POST /charges` creates a **pending** transaction; it only becomes **confirmed** when a verified webhook arrives at `POST /webhooks/:provider`. A request alone never moves money.
- **Idempotency** — every money endpoint requires an `Idempotency-Key`; a retry replays the stored result. Webhooks de-dupe on event id.
- **Sandbox provider** — runs the full request → pending → webhook → confirmed → ledger path with no real money. `APP_ENV` chooses sandbox vs live, not the code path.
- **Invoicing & collections (Phase 3)** — `POST /invoices` with per-merchant sequential numbers, integer tax, issue/cancel, and `POST /invoices/:id/payments` for full or partial payments that flow through the same ledger and advance the invoice state (draft → issued → partially_paid → paid; overdue derived). Transactions list + CSV export.
- **Payouts (Phase 4)** — `POST /payouts` creates a maker-checker request (no money moves); `POST /payouts/:id/approve` requires a different user, debits the balance under a lock, and submits to the provider. A rejected payout rolls its ledger move back. Balance-sufficiency is checked so a payout can't overdraw.
- **Refunds** — `POST /transactions/:id/refund` posts a new linked transaction + entries, never editing the original.
- **Settlement & reconciliation (Phase 4)** — `POST /settlements/import` ingests a provider settlement file and matches expected (our confirmed transactions) against actual on `providerRef`, producing matched / unmatched / mismatch / unexpected rows plus fee and net totals. `POST /reconciliation/:id/resolve` clears a mismatch with an adjustment entry — never an edit.
- **Bulk payments & payroll (Phase 5)** — `POST /batches` ingests recipients as JSON or CSV, **validates** (required fields, positive amounts, line-numbered errors) and flags **duplicate destinations**, then previews the total. `POST /batches/:id/approve` is maker-checker (a different user). `POST /batches/:id/execute` pays each item as its own ledger-posting payout and is **retry-safe**: an already-paid item is skipped, so re-running after a partial failure never double-pays. Per-item status is tracked.
- **Customer wallet + Axo-to-Axo P2P (Phase 6)** — a `Customer` is an individual wallet-holder (distinct from a merchant's staff `User`s), with its own `CustomerAccount` and a **separate double-entry customer ledger**. `sendP2P` moves money between two customers server-authoritatively: it quotes, checks account status (a **frozen** wallet is blocked), enforces **per-tier per-transaction and daily limits**, verifies funds, and posts balanced legs in one serializable transaction. Idempotent on `idempotencyKey` — a repeat never double-sends. Self-sends and cross-currency (without a provider route) are refused.
- **Customer pays a business (Phase 6)** — `POST /payments/customer` (merchant taken from the token, never the body; `Idempotency-Key` required): a customer pays the business over Axo and the money lands straight in the merchant's `axo_balance`. Posted on **both** ledgers in one transaction (customer: wallet → clearing; merchant: clearing → balance), so the business sees it in its statements, reports and reconciliation — with no telco till in between.
- **Pay a business by its Till / Paybill over WhatsApp (Phase 6)** — the full M-Pesa-equivalent, from the individual's chat: any Axo wallet-holder sends `TILL 832909 500` or `PAYBILL 600921 RENT 5000` and `payByNumber` resolves the Axo-issued `PayNumber` to the merchant (validating the account line for a paybill), then runs the same server-authoritative `payMerchant` path (ledger, risk screen, idempotency). An unknown number or account line is refused, never guessed.
- **First-contact onboarding — ANYONE with WhatsApp can pay (Phase 6)** — a brand-new number that has never used Axo and texts `PAY TILL 832909 500` is **not turned away**: the router stashes the intended payment (`PendingPayIntent`), sends a one-step OTP, and the moment they verify, `resumePendingPay` creates their wallet and completes the payment automatically. So it works exactly like M-Pesa, where any phone can just pay a till — no prior signup, no app to install, the wallet is created on the spot as part of the first payment. `shouldOnboardForPayment` gates this to payment intents only (a bare `BALANCE`/`HELP` from a stranger still gets the normal prompt).
- **WhatsApp Cloud API gateway (Phase 6)** — `GET /webhooks/whatsapp` does Meta's subscription handshake; `POST /webhooks/whatsapp` **verifies the `X-Hub-Signature-256` HMAC over the raw body** (constant-time), **de-dupes** on the WhatsApp message id (retries are ignored), and routes the message. Conversational flows: `REGISTER` → OTP (6-digit, argon2id-hashed, expiring, attempt-capped) → wallet; `BALANCE`, `SEND <amt> to @tag`, `HISTORY`, `HELP`. Verbs parsed in English, Swahili and Somali. A money action requires a **live verified session**, not just a linked number — WhatsApp identity alone never authorizes a transfer. Outbound messaging is a documented adapter: unconfigured credentials ⇒ reported **unavailable**, never a faked send.
- **Cash-in / cash-out ramps (Phase 7)** — the on-ramp/off-ramp. A `RampProvider` adapter declares which ops, countries and currencies it supports and whether it is configured; `pickRamp` chooses one or returns **nothing** (feature genuinely unavailable — never a faked transfer). **Cash-in** creates a PENDING record, submits to the ramp, and only **credits the wallet when a verified webhook confirms** (wallet credit vs clearing debit — the customer ledger stays balanced). **Cash-out** **reserves** the funds immediately so they can't be double-spent, submits to the ramp, and **debits on confirm**; a rejection or a failed webhook **releases the reservation**. Idempotent on `idempotencyKey`; webhook de-dup on event id and a status guard so a replayed webhook is a no-op. Ships with a signed-webhook sandbox ramp and an **M-Pesa (Daraja) adapter template** that is unavailable until credentials are supplied.
- **Risk & compliance (Phase 8)** — a pure, explainable risk engine (`assessRisk`) scores every customer-initiated movement BEFORE money moves: sanctions/fraud **denylist** hits (sender/recipient/cash-out destination) force a block; **velocity** (txns/hour), **fan-out** (many recipients fast), **possible structuring** (repeated near-limit amounts) and spikes raise weighted, logged signals → `allow` / `review` / `block`. The screen is wired into `sendP2P` and cash-out: a **block** refuses and opens a case; a **review** proceeds but opens a case for an analyst. **Account freeze/release** is maker-checker (the operator who froze cannot release); a frozen wallet can't debit. `RiskCase` tracks review/blocked/freeze/fraud-report cases with their firing signals; a denylist and a fraud-report endpoint round it out. Every decision is deterministic and reconstructable from the stored signals.
- **QR + STK-style push-to-pay (Phase 9)** — `GET /collect/qr` builds a scannable `axo://pay?…` string for the merchant's Till/Paybill (optionally with a baked-in amount). `POST /collect/push` is the **STK equivalent**: the merchant pushes a pay prompt to a customer's Axo/WhatsApp and **no money moves** — it creates a PENDING `PushPrompt` (a CheckoutRequestID-style `ref`, 2-min expiry) and notifies the customer. The customer approves with **YES** in WhatsApp (or `POST /collect/push/:ref/approve`), and only then does the same `payMerchant` path run, idempotent on the prompt ref. `POST /collect/scan` turns a scanned QR into a push the customer confirms — scanning never auto-charges.
- **Crypto receive + global send (Phase 9)** — a **crypto `RampProvider`** (USDC/USDT/USD, global) lets a business **receive stablecoin** into its Axo balance (webhook-confirmed, credited through the ledger like any cash-in) and **send stablecoin out**; unavailable without custody credentials, so it never fakes a transfer. `POST /global/quote` gives an integer-safe, **spread-disclosed FX quote**; `POST /global/send` executes a cross-border transfer as a reserved cash-out through a configured ramp (the crypto rail, or a bank/agent abroad), settling on the ramp webhook. A pair with no rate is refused.
- **More M-Pesa parity (Phase 10)** — the remaining individual-side features:
  - **Send to an unregistered number** — `SENDTO +254711 500` to anyone, even with no Axo wallet. The sender's funds are **reserved**, the recipient gets a `CLAIM <code>` message; claiming provisions their wallet and completes it; unclaimed sends **auto-refund** after 7 days (`sweepExpiredClaims`) or on `RECALL <code>`. (`ClaimableTransfer`.)
  - **Reverse / recall a payment** — `reverseTransfer` recalls a completed Axo-to-Axo transfer within a 10-minute window: it posts a **new compensating transfer**, never edits the original, and only if the recipient still holds the funds.
  - **Per-transaction PIN** — the M-Pesa PIN as step-up: `SETPIN 1234` stores an argon2id hash; `verifyPin` caps failed attempts and **freezes** the account after 5 wrong tries.
  - **Mini-statement + fee preview** — `MINI` returns the last 5 like an M-Pesa SMS; `previewFee` shows the cost before confirming (free for Axo-to-Axo/pay-business, a disclosed 1% on cash-out/global — never hidden).
- **Chat safety & usability (Phase 12)** — the individual's WhatsApp experience, hardened for real, non-technical users. **Every send now confirms before money moves**: `SEND 500 to @amina` replies "Confirm: Send KES 500 to @amina — reply with your PIN" and **nothing moves until the PIN** (or YES, if no PIN is set) is entered — the M-Pesa "enter PIN to pay" step, so a typo or a stranger can't drain a wallet. Wrong PINs are capped (the account locks after repeated failures). A **friendlier fallback** (`coachUnknown`) reads vague messages like "I want to send money" / "nataka kutuma" / "how much do I have" (English, Swahili, Somali) and guides the user to the right command instead of "I didn't catch that." **Per-user currency**: amounts are parsed and shown in each customer's own currency and decimals (KES zero-decimal; **Somalia = USD, two-decimal**), inferred from the phone prefix at signup.
- **Everyday M-Pesa / EVC parity for individuals (Phase 14)** — the daily-use features a person expects, added to the chat (nothing existing removed): **`WITHDRAW <amount> from <agent>`** (cash-out at an Axo agent like `AMRAN`, via `agentCashOut`); **`AIRTIME <amount> [phone]`** (buy airtime/data for yourself or anyone); **`BILL <power|water|tv|internet> <account> <amount>`** and **`TOKEN <meter> <amount>`** for utilities — an electricity payment returns a **20-digit meter token** to enter; **`REQUEST <amount> from @tag`** (ask someone to pay you — they get a ready-to-send prompt); **`REVERSE <txn>`** (recall a completed send within the window); and **`CHANGEPIN <old> <new>`**. Every money action still goes through the confirm-and-PIN step. Billers debit the wallet through the same double-entry customer ledger (`BillerPurchase`).
- **Two-sided symmetry (Phase 13)** — every money direction now exists on both sides. A **business pays an individual's Axo wallet** (`businessPayCustomer`, `POST /payments/to-customer`) — the mirror of a customer paying a business — and the individual is **notified on WhatsApp** ("💰 You received X from <business>") via `notifyCredit`, so inbound money reads as clearly as a person-to-person send. The individual chat also gains the powers the business Hub already had: **`CRYPTO`** shows the customer's stablecoin deposit address (receive USDC/USDT from anywhere), and **`GLOBAL <amount> <CUR> to <dest>`** sends cross-border through the ramp, confirm-and-PIN-gated like every send. Each business "receive" feature maps to an individual "send" feature and back.
- **Account recovery & lost-phone claims (Phase 15)** — a pending send is tied to a *number*, but a person can lose the number the money was addressed to. Two functions close that gap so money follows the person, not the SIM. **`claimByIdentity({ code, customerId })`** settles a pending claim to a customer who has **proven their identity** (the recovery flow: permanent Axo ID + recovery email + Axo Code) even though the recipient number no longer matches — identity, not the number, is the authority; a frozen account is refused. The WhatsApp `CLAIM <code>` handler uses this automatically: if a verified user claims a code addressed to a number they no longer use, it falls back from the number match to the identity match. **`repointClaimsToNewNumber({ oldWaId, newWaId })`** moves every still-unclaimed transfer from an old number to a new one during recovery / number change, so a payment in flight is never stranded. Exposed at `POST /claims/:code/claim-by-identity` and `POST /claims/repoint`; the individual front-end surfaces the re-point on the number-change receipt ("1 payment moved to this account").
- **Agent network — Axo's own cash on-ramp/off-ramp (Phase 11)** — an `Agent` has a prepaid **float** and earns **commission**. `agentCashIn` credits a customer's wallet from the agent's float (a customer hands over cash → wallet goes up, float goes down); `agentCashOut` does the reverse (agent pays cash → wallet down, float up). Both settle **instantly against float — no telco, no external webhook** — post through the customer ledger (balanced vs clearing), accrue the agent's commission, and are idempotent. An agent can't cash-in beyond its float, and can't cash-out more than the customer holds. This is the on-ramp that makes Axo independent of any telco: the same model M-PESA used to bootstrap, owned by Axo.
- **Tests** — money math, ledger invariants, invoice logic, reconciliation, batch validation, P2P limits/legs/service, WhatsApp signature/de-dup/intent/OTP (pay-Till/Paybill, send-to-phone, claim/recall, setpin, mini), **claimable transfers (claim-by-number, claim-by-identity, re-point)**, cash ramps, risk, QR/FX/crypto, and **mini-statement + fee-preview + PIN-format** all pass (`npm test`, **155 tests**). DB-backed integration cases are documented in `test/README.md`.

## Run it

```bash
cp .env.example .env            # fill in secrets
docker compose up -d            # Postgres + Redis
npm install
npm run prisma:migrate          # create the schema
npm run seed                    # demo merchant: owner@java.test / password123
npm run dev                     # http://localhost:4000/health
npm test                        # unit tests (no services needed)
```

## Try the money path (sandbox)

```bash
# 1) log in
curl -s localhost:4000/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@java.test","password":"password123"}'
# -> { accessToken, refreshToken, role }

# 2) create a charge (pending) — note the Idempotency-Key
curl -s localhost:4000/charges -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"amountMinor":"50000","currency":"KES","customerRef":"+254712345678"}'
# -> transaction, status: pending, providerRef: sbx_<id>

# 3) the provider confirms via a signed webhook (sandbox signs it for you in tests)
#    only now does the ledger credit the merchant and status -> confirmed
```

## Try the WhatsApp / P2P path (sandbox)

```bash
npm run seed   # also seeds @amina (funded, KES 5,000) and @juma (empty)

# 1) GET verification handshake (what Meta calls to confirm your webhook)
curl -s "localhost:4000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=42"
# -> 42

# 2) an inbound "SEND 1000 to @juma" from @amina's number, correctly signed.
#    The body must be signed with WHATSAPP_APP_SECRET or it is rejected 401.
BODY='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.1","from":"254712345678","type":"text","text":{"body":"SEND 1000 to @juma"}}]}}]}}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | awk '{print $2}')"
curl -s localhost:4000/webhooks/whatsapp -H "content-type: application/json" \
  -H "x-hub-signature-256: $SIG" -d "$BODY"
# -> {"ok":true}; @amina's wallet is debited, @juma's credited, both ledger legs net to zero.
# Re-posting the SAME body (same message id) returns {"duplicate":true} and moves nothing.

# 3) PAY A BUSINESS by its Axo Till / Paybill — exactly like an M-Pesa customer,
#    but over WhatsApp. The seed gives the demo merchant Till 832909 + Paybill 600921.
#    "PAYBILL 600921 RENT 5000"  (or "TILL 832909 500")  from @amina's number:
#    -> money lands in the merchant's Axo balance; it shows in merchant statements.
```

## API & webhook reference (Phase 6)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/payments/customer` | merchant JWT + `Idempotency-Key` | A customer pays this business; credits merchant `axo_balance`. |
| `GET`  | `/customers` | owner/accountant JWT | Wallet-holder monitoring (admin). |
| `GET`  | `/webhooks/whatsapp` | verify token | Meta subscription handshake. |
| `POST` | `/webhooks/whatsapp` | HMAC signature | Inbound messages; signature-verified + de-duped. |
| `GET`  | `/ramps` | owner/accountant JWT | Ramp provider connection status (which are configured). |
| `POST` | `/cash/in` | merchant JWT + `Idempotency-Key` | Start a cash-in; 503 `ramp_unavailable` if none configured. |
| `POST` | `/cash/out` | merchant JWT + `Idempotency-Key` | Start a cash-out; reserves funds, debits on webhook. |
| `POST` | `/webhooks/ramp/:provider` | adapter signature | Ramp confirmation; the only place a cash movement posts. |
| `GET`  | `/risk/cases` | owner/accountant JWT | Compliance case queue (filter by `status`). |
| `POST` | `/risk/customers/:id/freeze` | owner JWT | Freeze an account (opens a case). |
| `POST` | `/risk/cases/:caseId/release` | owner JWT (≠ freezer) | Release a freeze — maker-checker enforced. |
| `POST` | `/risk/cases/:caseId/resolve` | owner/accountant JWT | Clear or confirm a transaction case. |
| `POST` | `/risk/report` | any JWT | File a fraud report (opens a case). |
| `POST` | `/risk/denylist` | owner JWT | Add a sanctions/fraud denylist entry. |
| `GET`  | `/collect/qr` | merchant JWT | Build a scannable `axo://pay?…` QR for the business's Till/Paybill. |
| `POST` | `/collect/push` | merchant JWT | STK-style push-to-pay: send a pay prompt (no money moves). |
| `POST` | `/collect/push/:ref/approve` | customer/approval | Approve a push → runs the payment. |
| `POST` | `/collect/scan` | JWT | A scanned QR → a push the customer then approves. |
| `POST` | `/global/quote` | JWT | Cross-border FX quote (spread disclosed). |
| `POST` | `/global/send` | owner/accountant JWT + `Idempotency-Key` | Send globally via a ramp (crypto / bank / agent). |
| `POST` | `/transfers/to-phone` | JWT + `Idempotency-Key` | Send to any phone (registered or not); recipient claims. |
| `POST` | `/claims/:code/claim` | recipient | Claim a send-to-unregistered. |
| `POST` | `/claims/:code/claim-by-identity` | JWT (verified) | Claim a pending send to a recovered account (lost phone / new number). |
| `POST` | `/claims/repoint` | JWT (verified) | Re-point unclaimed money from an old number to a new one. |
| `POST` | `/claims/:code/recall` | JWT | Recall an unclaimed send. |
| `POST` | `/transfers/:id/reverse` | JWT | Reverse a completed Axo-to-Axo transfer (within window). |
| `POST` | `/agents` | owner JWT | Register an agent (Axo's cash network). |
| `POST` | `/agents/:code/float` | owner/accountant JWT | Top up an agent's float. |
| `POST` | `/agents/:code/cash-in` | JWT + `Idempotency-Key` | Customer gives cash → wallet credited from float. |
| `POST` | `/agents/:code/cash-out` | JWT + `Idempotency-Key` | Agent pays cash → wallet debited, float up. |
| `GET`  | `/agents/:code` | JWT | Agent float, commission, recent activity. |

Programmatic P2P is exposed through the service (`sendP2P`) and the WhatsApp router; a customer-facing JWT surface for direct `POST /transfers` is the small remaining wiring noted below.

## What is NOT built yet

- **Customer-facing auth surface** — the WhatsApp session is the auth path for customers today; a standalone customer JWT/`POST /transfers` endpoint is a thin add on top of `sendP2P`.
- **Cross-currency / cross-border P2P** — deliberately refused until a provider FX route is wired (the adapter layer is ready for it).
- **Live ramp adapters** — the ramp interface, registry, sandbox, and an M-Pesa (Daraja) adapter *template* are built and tested; wiring the template to live STK push / B2C (and adding bank / agent adapters) needs real partner credentials (see below).
- **Still from earlier phases:** bills/airtime, credit, crypto custody, and the full admin console UI. (Disputes/fraud now have a server-side case model via `RiskCase` + `/risk/report`; a richer per-case event timeline and SLA routing is the next refinement.)
- **Live sanctions/PEP screening** — the denylist + engine are built and tested; wiring a real screening provider (to populate `DenylistEntry`) is a credentials step.

## Integrations requiring external credentials or partner approval

| Integration | Needs | Until configured |
|---|---|---|
| WhatsApp outbound (Cloud API) | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` | Sender reports **unavailable**; inbound still verifies. |
| WhatsApp inbound verification | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Dev defaults work locally; set real values in live. |
| Bank / PSP settlement rails | Per-provider API key + webhook secret | Feature labelled unavailable; sandbox adapter only. |
| M-Pesa ramp (cash-in/out, KE) | `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_WEBHOOK_SECRET` + a Safaricom Daraja agreement | Adapter reports **unavailable**; `/cash/*` returns 503, never a faked transfer. |
| Cash-in/out agent / bank networks | Contractual + API access | New `RampProvider` adapters drop in behind the same interface; unavailable until configured. |

A technical integration is **not** regulatory permission: each financial service must run through the appropriately licensed Axstron entity for its market.

## Structure

```
prisma/schema.prisma      core tables (money = BigInt minor units)
src/
  config/env.ts           validated env
  db/client.ts            Prisma + serializable transactions
  lib/money.ts            minor-unit math (no floats)
  middleware/
    auth.ts               JWT + requireRole (server-enforced)
    idempotency.ts        Idempotency-Key handling
  modules/
    auth/                 login, refresh, hashing
    merchants/            onboarding, me, accounts
    ledger/               postLedger + integrity checks
    payments/             createCharge, confirm-from-webhook, reverse
    invoices/             invoices + sequential numbers + partial payments
    payouts/              maker-checker payouts + refunds
    reconciliation/       settlement import + matching + adjustments
    batches/              bulk/payroll: CSV, validate, maker-checker, retry-safe
    p2p/                  customer wallets, Axo-to-Axo send, customer-pays-business
      p2p.lib.ts          pure: quote, limit/status checks, legs (DB-free, tested)
      p2p.service.ts      sendP2P + payMerchant (both ledgers, serializable)
      p2p.routes.ts       POST /payments/customer, GET /customers
    whatsapp/             the WhatsApp money gateway
      whatsapp.lib.ts     pure: subscription verify, HMAC verify, extract, parseIntent
      whatsapp.service.ts OTP issue/verify, link + step-up session, webhook de-dup
      whatsapp.sender.ts  outbound adapter (sandbox + Cloud API; unavailable if unconfigured)
      whatsapp.routes.ts  GET/POST /webhooks/whatsapp + conversational router
    cash/                 cash-in / cash-out ramps
      cash.service.ts     startCashIn, startCashOut (reserve), applyRampWebhook
      cash.routes.ts      /cash/in, /cash/out, /ramps, /webhooks/ramp/:provider
    collect/              QR + STK-style push-to-pay
      collect.lib.ts      pure: QR encode/parse, push ref (tested)
      collect.service.ts  pushPrompt, approvePush, resolveQrToPush
      collect.routes.ts   /collect/qr, /collect/push(+approve/decline), /collect/scan
    global/               crypto receive + cross-border send
      fx.lib.ts           pure: integer-safe FX quote with disclosed spread (tested)
      global.routes.ts    /global/quote, /global/send
    agent/                Axo's own cash on-ramp/off-ramp network
      agent.lib.ts        pure: commission + float checks (tested)
      agent.service.ts    agentCashIn / agentCashOut (float↔wallet, instant)
      agent.routes.ts     /agents, float top-up, cash-in, cash-out, dashboard
    risk/                 risk & compliance
      risk.lib.ts         pure: assessRisk scoring + denylist match (tested)
      risk.service.ts     screenMovement, freeze/release (maker-checker), cases
      risk.routes.ts      /risk/cases, freeze, release, resolve, report, denylist
  providers/              adapter interface + sandbox
    ramp.ts               RampProvider interface + capability matcher
    ramp.sandbox.ts       in-memory signed-webhook ramp (dev/tests)
    ramp.mpesa.ts         M-Pesa (Daraja) adapter TEMPLATE — unavailable w/o creds
    ramp.crypto.ts        crypto rail (USDC/USDT, global) — unavailable w/o creds
    ramp.registry.ts      pickRamp() + rampStatus() for ops/admin
```

## Schema additions (Phases 6–8)

`Customer`, `CustomerAccount`, `CustomerLedgerEntry`, `WhatsAppLink`, `OtpChallenge`, `P2PTransfer`, `CashTransfer`, `PayNumber`, `PayNumberLine`, `PushPrompt`, `PendingPayIntent`, `ClaimableTransfer`, `Agent`, `AgentTxn`, `BillerPurchase`, `PendingConfirm`, `RiskCase`, `DenylistEntry`, plus `p2p_transfer` / `cash_in` / `cash_out` transaction types. `PayNumber`/`PayNumberLine` are the Axo-issued Till/Paybill numbers (and their account lines) that resolve a paid number to a merchant. Run `npm run prisma:migrate` to apply. Money stays `BigInt` minor units; the customer ledger enforces the same debits==credits invariant as the merchant ledger, and serves both P2P and cash flows (an entry's `source` says which). A cash movement only ever posts to the wallet inside `applyRampWebhook` — i.e. on a verified provider confirmation, never on the request.
