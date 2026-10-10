import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();
const pepper = process.env.ARGON2_PEPPER ?? '';

async function main() {
  const hash = (s: string) => argon2.hash(s + pepper, { type: argon2.argon2id });

  const merchant = await prisma.merchant.create({
    data: {
      legalName: 'Java House Ltd',
      tradingName: 'Java House — Yaya',
      country: 'KE',
      currency: 'KES',
      axoId: 'AXO-DEMO0001',
      kybTier: 'registered',
      kybStatus: 'verified',
      users: {
        create: [
          { name: 'Owner', email: 'owner@java.test', role: 'owner', passwordHash: await hash('password123') },
          { name: 'Cashier', email: 'cashier@java.test', role: 'cashier', passwordHash: await hash('password123') },
        ],
      },
      accounts: {
        create: [
          { type: 'axo_balance', currency: 'KES' },
          { type: 'clearing', currency: 'KES' },
        ],
      },
    },
  });

  // Axo-issued payment numbers for the business (the M-Pesa Till/Paybill
  // equivalents an individual pays over WhatsApp).
  await prisma.payNumber.create({ data: { merchantId: merchant.id, kind: 'till', number: '832909', label: 'Buy Goods' } });
  await prisma.payNumber.create({
    data: {
      merchantId: merchant.id, kind: 'paybill', number: '600921', label: 'Paybill',
      lines: { create: [{ account: 'RENT', name: 'Shop rent' }, { account: 'MAIN', name: 'Main account' }] },
    },
  });

  // An Axo cash agent (for the WITHDRAW flow) — "Amran", with starting float.
  await prisma.agent.create({ data: { code: 'AMRAN', name: 'Amran Mobile Agent', country: 'KE', currency: 'KES', floatMinor: 500000n, commissionBps: 50 } });

  // Phase 6 — demo customers (wallet-holders) for the WhatsApp / P2P paths.
  // Amina starts funded; Juma is empty. Balances are set via an opening ledger
  // posting in a real run; here we seed the cached balance for a quick demo.
  const amina = await prisma.customer.create({
    data: {
      axoTag: '@amina', displayName: 'Amina Y.', country: 'KE', currency: 'KES',
      status: 'active', kycTier: 'verified',
      wallet: { create: { currency: 'KES', balanceMinor: 5000n } },
      waLink: { create: { waId: '254712345678', phone: '+254712345678', verifiedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 36e5) } },
    },
  });
  await prisma.customer.create({
    data: {
      axoTag: '@juma', displayName: 'Juma K.', country: 'KE', currency: 'KES',
      status: 'active', kycTier: 'basic',
      wallet: { create: { currency: 'KES', balanceMinor: 0n } },
      waLink: { create: { waId: '254722000111', phone: '+254722000111', verifiedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 36e5) } },
    },
  });

  // eslint-disable-next-line no-console
  console.log('Seeded merchant', merchant.axoId, '— login owner@java.test / password123');
  // eslint-disable-next-line no-console
  console.log('Seeded customers', amina.axoTag, '(funded) and @juma (empty) for WhatsApp/P2P demo');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
