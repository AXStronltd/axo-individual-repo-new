# Axo for Individual

A WhatsApp-native personal wallet — a telco-free alternative to M-PESA and EVC for everyday people. It opens as a WhatsApp chat: tap the **Axo ✓** conversation to bank. No SIM to register, no app to install.

## What a person can do

Send and receive money, pay a Till or Paybill, scan a QR, approve an STK-style push, convert currency and crypto, top up from any bank with a reference, withdraw cash at an agent, buy airtime, pay utility bills (electricity returns a meter token), request money, and recall a wrong send — each money action protected by a confirm-and-PIN step. Amounts show in the user's own currency (KES, or USD for Somalia). Lose your phone or change your number and your **permanent Axo ID** brings everything back: balance, history, and any money still waiting to be claimed is **re-pointed to your recovered account** — identity, not the SIM, is the authority.

## Layout

```
frontend/   The consumer wallet — self-contained HTML (index.html is the full app).
            Also carries the earlier prototypes (convert, simulator, whatsapp demo).
backend/    The money engine the wallet runs on — TypeScript · Fastify · PostgreSQL
            (Prisma). A double-entry ledger, idempotency, P2P transfers, pay-a-business,
            cash-in/out ramps (agent, M-Pesa template, crypto), airtime & bills, risk
            controls, and the WhatsApp Cloud API gateway. See backend/README.md.
```

> The backend is shared infrastructure: the same money engine powers the business
> side too. This repo pairs it with the individual front-end.

## Frontend

The wallet is plain HTML and JavaScript with no build step: `frontend/index.html` plus `frontend/live.js`. It starts on a WhatsApp-style chat list; tap **Axo ✓** to open the wallet and choose one of two options:

- **Sign in to my wallet** with your Axo tag and PIN (for example the seeded `@amina` / `1234`). The chat then uses your real wallet on the backend:
  - balance and history
  - send to an @tag, or to any phone number
  - pay a Till or Paybill
  - scan or paste an Axo code
  - pay or decline a business's request
  - get cash at an agent, add money (including by bank transfer: the wallet is credited only when the bank confirms)
  - your "pay me" QR

  Money you receive and requests from businesses appear in the chat by themselves. Every payment asks for your PIN, and the server checks it again.
- **Try the demo**: the original walkthrough with sample money, labelled **DEMO** at the top.

New wallets are still created over WhatsApp (`REGISTER`); the demo's sign-up here is only a demo.

```bash
cd backend && npm run dev                      # API on http://localhost:4000
cd frontend && python3 -m http.server 8766     # then open http://127.0.0.1:8766
# a different API: http://127.0.0.1:8766/?api=http://localhost:4100
```

## Backend

```bash
cd backend
cp .env.example .env
docker compose up -d        # Postgres + Redis
npm install
npm run prisma:migrate
npm run seed                # demo wallets: @amina (funded), @juma; agent AMRAN
npm run dev                 # http://localhost:4000/health
npm test                    # 246 tests (DB e2e tests skip without Postgres)
```

## Status

246 automated tests pass. 62 of them run over HTTP against a real Postgres: paying a business with a PIN, exactly-once settlement, refunds, and the security fixes in **[SECURITY.md](SECURITY.md)**. Money units: KES in whole shillings; Somalia in USD cents. Nothing has run against live money, and the wallet frontend's live mode was tested end to end in a real browser. Going live needs funding rails, a security audit, and licensing (or a licensed partner). See `backend/README.md` and `docs/POS-API.md`.

---

© Axstron Group. All rights reserved.
