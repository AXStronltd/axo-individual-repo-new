import { describe, it, expect } from 'vitest';
import {
  quoteTransfer,
  checkTransfer,
  transferLegs,
  normalizeTag,
  normalizeWaId,
  TIER_LIMITS,
  type P2PQuote,
} from '../src/modules/p2p/p2p.lib.js';

const baseQuote: P2PQuote = { amountMinor: 50000n, feeMinor: 0n, totalMinor: 50000n };

function check(overrides: Partial<Parameters<typeof checkTransfer>[0]> = {}) {
  return checkTransfer({
    senderStatus: 'active',
    recipientStatus: 'active',
    senderId: 'A',
    recipientId: 'B',
    currency: 'KES',
    senderCurrency: 'KES',
    recipientCurrency: 'KES',
    spendableMinor: 100000n,
    spentTodayMinor: 0n,
    tier: 'basic',
    quote: baseQuote,
    ...overrides,
  });
}

describe('quoteTransfer', () => {
  it('is free by default (Axo-to-Axo)', () => {
    const q = quoteTransfer(50000n);
    expect(q.feeMinor).toBe(0n);
    expect(q.totalMinor).toBe(50000n);
  });
  it('rejects non-positive amounts', () => {
    expect(() => quoteTransfer(0n)).toThrow();
    expect(() => quoteTransfer(-1n)).toThrow();
  });
});

describe('checkTransfer', () => {
  it('passes a normal transfer', () => {
    expect(check()).toEqual({ ok: true });
  });
  it('blocks sending to yourself', () => {
    expect(check({ recipientId: 'A' })).toMatchObject({ ok: false });
  });
  it('blocks a frozen sender', () => {
    expect(check({ senderStatus: 'frozen' })).toMatchObject({ ok: false, reason: /frozen/ });
  });
  it('blocks a frozen recipient', () => {
    expect(check({ recipientStatus: 'frozen' })).toMatchObject({ ok: false });
  });
  it('blocks insufficient funds', () => {
    expect(check({ spendableMinor: 40000n })).toMatchObject({ ok: false, reason: /insufficient/ });
  });
  it('enforces the per-transaction tier limit', () => {
    const big = TIER_LIMITS.basic.perTxnMinor + 1n;
    expect(check({ quote: { amountMinor: big, feeMinor: 0n, totalMinor: big }, spendableMinor: big + 1n }))
      .toMatchObject({ ok: false, reason: /per-transaction/ });
  });
  it('enforces the daily limit', () => {
    expect(check({ spentTodayMinor: TIER_LIMITS.basic.dailyMinor })).toMatchObject({ ok: false, reason: /daily/ });
  });
  it('blocks cross-currency without a provider route', () => {
    expect(check({ recipientCurrency: 'USD' })).toMatchObject({ ok: false, reason: /currency/ });
  });
});

describe('transferLegs', () => {
  it('produces a balanced debit/credit pair', () => {
    const legs = transferLegs({ senderAccountId: 's', recipientAccountId: 'r', amountMinor: 50000n, currency: 'KES' });
    expect(legs).toHaveLength(2);
    const net = legs.reduce((n, l) => n + (l.direction === 'credit' ? l.amountMinor : -l.amountMinor), 0n);
    expect(net).toBe(0n);
  });
});

describe('tag + waId normalization', () => {
  it('normalizes tags and rejects bad ones', () => {
    expect(normalizeTag('amina')).toBe('@amina');
    expect(normalizeTag('@Amina')).toBe('@amina');
    expect(normalizeTag('@a')).toBeNull();
    expect(normalizeTag('@has space')).toBeNull();
  });
  it('normalizes phone numbers to digits', () => {
    expect(normalizeWaId('+254 712 345 678')).toBe('254712345678');
    expect(normalizeWaId('abc')).toBeNull();
  });
});
