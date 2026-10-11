# Security fixes (October 2026)

This repo carries its own copy of the Axo money engine, which is shared with Axo for Business. An audit of that engine found ways money could move without its owner's consent. The same fixes were applied to both repos (Axo for Business PR: https://github.com/AXStronltd/axo-business/pull/1).

| # | Problem | Fix |
|---|---|---|
| S1 | A customer could pay a business, then `REVERSE` and get the money back while the business kept the credit | Reversal refused for any leg touching a clearing wallet; businesses refund instead |
| S2 | Any business's staff token could debit any customer's wallet (`customerId` in the request body) | Customer actions live under `/customer/*`: the wallet is the token's own, with a PIN step-up on every debit |
| S3 | Any business owner could create an agent, give it float from nothing, and cash it out | Agent and float operations need the platform operator key (`X-Ops-Key` = `OPS_API_KEY`) |
| S4 | Charge webhooks forgeable in live (hard-coded secret) | Sandbox provider not registered in live; raw-body verification |
| S5 | Approving a push needed no login or PIN; a bare `YES` paid on WhatsApp | Token + PIN, or the WhatsApp PIN confirmation |
| S6 | A payment could be refunded repeatedly, and the refund never reached the customer | Capped refunds, credited to the customer's wallet |
| S7 | Live mode started with public default secrets | The process refuses to start |
| S8 | Idempotency keys shared across businesses | Scoped by business + endpoint (customer keys by customer) |
| S9 | Bill payments debited real money for a random token | Refused in live until a biller provider is integrated |

Also fixed:
- Replying to a WhatsApp payment with a bare PIN was read as a sign-up code, so PIN payments couldn't complete.
- `RECALL` didn't check who was recalling.
- First-contact WhatsApp pay hard-coded `KES`.
- `npm start` pointed at a file the build never produced.

Later hardening: P2P sends can never target the internal clearing wallets (`sendP2P` refuses them, which covers WhatsApp `SEND` too).

Bank top-ups (merged from the uploaded bank-collection files): the upload was fixed before merging.
- **Wallet credits:** its manual-confirm route let any business owner or accountant credit any wallet with money that never arrived. Only the platform operator key (`X-Ops-Key`) can confirm deposits now.
- **Cash routes:** it re-opened `/cash/in` and `/cash/out` under merchant tokens. They stay removed.
- **References:** any staff token could create or cancel references for any customer. Each customer now manages their own.
- **Exactly once:** the bank webhook must be signed and must carry the bank's transaction id. One bank transaction can credit only one reference, and a reference credits only once.
- **Tests:** these are in `backend/test/bank-collection.e2e.test.ts`.

Each fix is tested by asserting that money did **not** move (`backend/test/payment-requests.e2e.test.ts`, `backend/test/hardening.test.ts`).

## Still needed before live money

Funding and withdrawal rails, an e-money licence or a licensed partner, WhatsApp production approval from Meta, a KYC provider, a biller aggregator, crypto custody, and a sanctions-screening feed.

**Currency units — decided:** KES (and UGX, TZS, RWF, SOS) are kept in whole shillings, with no cents. Other currencies use their normal decimals. Somalia transacts in USD, in cents (a +252 number gets a USD wallet). An amount more precise than its currency (e.g. `KES 12.50`) is refused, never rounded. The WhatsApp HISTORY, MINI and credit messages now show USD with cents.
