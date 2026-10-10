# Axo for Individual

A WhatsApp-native personal wallet — a telco-free alternative to M-PESA and EVC for everyday people. It opens as a WhatsApp chat: tap the **Axo ✓** conversation to bank. No SIM to register, no app to install.

## What a person can do

Send and receive money, pay a Till or Paybill, scan a QR, approve an STK-style push, convert currency and crypto, withdraw cash at an agent, buy airtime, pay utility bills (electricity returns a meter token), request money, and recall a wrong send — each money action protected by a confirm-and-PIN step. Amounts show in the user's own currency (KES, or USD for Somalia). Lose your phone or change your number and your **permanent Axo ID** brings everything back: balance, history, and any money still waiting to be claimed is **re-pointed to your recovered account** — identity, not the SIM, is the authority.

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

The wallet is a single self-contained HTML file — open `frontend/index.html` in a browser. It starts on a WhatsApp chat list; tap **Axo ✓** to enter the wallet.

## Backend

```bash
cd backend
cp .env.example .env
docker compose up -d        # Postgres + Redis
npm install
npm run prisma:migrate
npm run seed                # demo wallets: @amina (funded), @juma; agent AMRAN
npm run dev                 # http://localhost:4000/health
npm test                    # 211 tests (DB e2e tests skip without Postgres)
```

## Status

211 automated tests pass. 40 of them run over HTTP against a real Postgres: paying a business with a PIN, exactly-once settlement, refunds, and the security fixes in **[SECURITY.md](SECURITY.md)**. Nothing has run against live money, and the pages in `frontend/` are demo data that don't call the API yet. Going live needs funding rails, a security audit, and licensing (or a licensed partner). See `backend/README.md` and `docs/POS-API.md`.

---

© Axstron Group. All rights reserved.
