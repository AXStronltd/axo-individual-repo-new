import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();
const pepper = process.env.ARGON2_PEPPER ?? '';

// Re-runnable: every record is upserted on a natural key, so seeding twice is a
// no-op rather than a unique-constraint crash.
async function main() {
  const hash = (s: string) => argon2.hash(s + pepper, { type: argon2.argon2id });

  const merchant = await prisma.merchant.upsert({
    where: { axoId: 'AXO-DEMO0001' },
    update: {},
    create: {
      legalName: 'Java House Ltd',
      tradingName: 'Java House — Yaya',
      country: 'KE',
      currency: 'KES',
      axoId: 'AXO-DEMO0001',
      kybTier: 'registered',
      kybStatus: 'verified',
      accounts: {
        create: [
          { type: 'axo_balance', currency: 'KES' },
          { type: 'clearing', currency: 'KES' },
        ],
      },
    },
  });

  for (const u of [
    { name: 'Owner', email: 'owner@java.test', role: 'owner' as const },
    { name: 'Cashier', email: 'cashier@java.test', role: 'cashier' as const },
  ]) {
    // The password hash is refreshed on re-seed too: these are documented demo
    // credentials, so seeding must restore them rather than leave an older hash
    // (made under a different ARGON2_PEPPER) that no longer accepts the
    // password this script prints.
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash: await hash('password123'), role: u.role, merchantId: merchant.id },
      create: { ...u, merchantId: merchant.id, passwordHash: await hash('password123') },
    });
  }

  // Axo-issued payment numbers for the business (the M-Pesa Till/Paybill
  // equivalents an individual pays over WhatsApp). A business can now also issue
  // these itself via POST /paynumbers; these two keep the demo deterministic.
  await prisma.payNumber.upsert({
    where: { kind_number: { kind: 'till', number: '832909' } },
    update: {},
    create: { merchantId: merchant.id, kind: 'till', number: '832909', label: 'Buy Goods' },
  });
  await prisma.payNumber.upsert({
    where: { kind_number: { kind: 'paybill', number: '600921' } },
    update: {},
    create: {
      merchantId: merchant.id, kind: 'paybill', number: '600921', label: 'Paybill',
      lines: { create: [{ account: 'RENT', name: 'Shop rent' }, { account: 'MAIN', name: 'Main account' }] },
    },
  });

  // An Axo cash agent (for the WITHDRAW flow) — "Amran", with starting float.
  await prisma.agent.upsert({
    where: { code: 'AMRAN' },
    update: {},
    create: { code: 'AMRAN', name: 'Amran Mobile Agent', country: 'KE', currency: 'KES', floatMinor: 500000n, commissionBps: 50 },
  });

  // Demo customers (wallet-holders) for the WhatsApp / P2P / wallet-app paths.
  // Amina starts funded; Juma is empty. Both carry a PIN hash: the PIN is the
  // credential the individual app logs in with, and the step-up a payment
  // re-verifies, so without one the app cannot sign in at all.
  // Balances are set via an opening ledger posting in a real run; here the
  // cached balance is seeded directly for a quick demo.
  const customers = [
    {
      axoTag: '@amina', displayName: 'Amina Y.', kycTier: 'verified' as const,
      balanceMinor: 250000n, waId: '254712345678', phone: '+254712345678', pin: '1234',
    },
    {
      axoTag: '@juma', displayName: 'Juma K.', kycTier: 'basic' as const,
      balanceMinor: 0n, waId: '254722000111', phone: '+254722000111', pin: '4321',
    },
  ];

  for (const c of customers) {
    const existing = await prisma.customer.findUnique({ where: { axoTag: c.axoTag } });
    if (existing) {
      await prisma.customer.update({
        where: { id: existing.id },
        data: { pinHash: await hash(c.pin), pinFailures: 0, status: 'active' },
      });
      continue;
    }
    await prisma.customer.create({
      data: {
        axoTag: c.axoTag, displayName: c.displayName, country: 'KE', currency: 'KES',
        status: 'active', kycTier: c.kycTier,
        pinHash: await hash(c.pin),
        wallet: { create: { currency: 'KES', balanceMinor: c.balanceMinor } },
        waLink: { create: { waId: c.waId, phone: c.phone, verifiedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 36e5) } },
      },
    });
  }

  /* eslint-disable no-console */
  console.log('Seeded merchant', merchant.axoId, '— login owner@java.test / password123');
  console.log('Seeded till 832909 and paybill 600921 (lines RENT, MAIN)');
  console.log('Seeded customers @amina (funded, PIN 1234) and @juma (empty, PIN 4321)');
  /* eslint-enable no-console */
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
