import { describe, it, expect } from 'vitest';
import { supports } from '../src/providers/ramp.js';
import { SandboxRampProvider } from '../src/providers/ramp.sandbox.js';
import { MpesaRampProvider } from '../src/providers/ramp.mpesa.js';
import { CryptoRampProvider } from '../src/providers/ramp.crypto.js';

describe('ramp capability matching', () => {
  const sbx = new SandboxRampProvider('s');
  it('sandbox supports KES cash-in in Kenya', () => {
    expect(supports(sbx, 'cash_in', 'KE', 'KES')).toBe(true);
  });
  it('sandbox does not support an unlisted currency', () => {
    expect(supports(sbx, 'cash_in', 'KE', 'GBP')).toBe(false);
  });
});

describe('M-Pesa adapter is unavailable without credentials', () => {
  const mpesa = new MpesaRampProvider();
  it('reports unavailable and never fakes a transfer', async () => {
    expect(mpesa.available).toBe(false);
    expect(supports(mpesa, 'cash_in', 'KE', 'KES')).toBe(false); // unavailable => unsupported
    const r = await mpesa.cashIn({ amountMinor: 1000n, currency: 'KES', source: '2547', reference: 'x' });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('mpesa_not_configured');
  });
});

describe('crypto ramp (receive/send stablecoin)', () => {
  const crypto = new CryptoRampProvider('');
  it('supports USDC/USDT and is global, but unavailable without credentials', () => {
    expect(crypto.currencies).toContain('USDC');
    expect(crypto.countries).toEqual([]); // global
    expect(crypto.available).toBe(false);
  });
  it('refuses to move crypto when unconfigured (never fakes it)', async () => {
    const r = await crypto.cashIn({ amountMinor: 100n, currency: 'USDC', source: 'addr', reference: 'r' });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('crypto_not_configured');
  });
});

describe('sandbox ramp webhook signing + verification', () => {
  const sbx = new SandboxRampProvider('secret');
  it('accepts a correctly-signed webhook', () => {
    const { headers, rawBody } = sbx.signWebhook({ eventId: 'e1', providerRef: 'rin_1', op: 'cash_in', outcome: 'confirmed' });
    const v = sbx.parseWebhook(headers, rawBody);
    expect(v).toMatchObject({ valid: true, eventId: 'e1', providerRef: 'rin_1', op: 'cash_in', outcome: 'confirmed' });
  });
  it('rejects a tampered body', () => {
    const { headers, rawBody } = sbx.signWebhook({ eventId: 'e1', providerRef: 'rin_1', op: 'cash_in', outcome: 'confirmed' });
    expect(sbx.parseWebhook(headers, rawBody + 'x').valid).toBe(false);
  });
  it('rejects a missing signature', () => {
    expect(sbx.parseWebhook({}, '{}').valid).toBe(false);
  });
});

describe('cashIn/cashOut accept positive amounts only', () => {
  const sbx = new SandboxRampProvider('s');
  it('rejects non-positive', async () => {
    expect((await sbx.cashIn({ amountMinor: 0n, currency: 'KES', source: 'x', reference: 'r' })).status).toBe('rejected');
    expect((await sbx.cashOut({ amountMinor: -1n, currency: 'KES', destination: 'x', reference: 'r' })).status).toBe('rejected');
  });
});
