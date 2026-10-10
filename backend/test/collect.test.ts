import { describe, it, expect } from 'vitest';
import { encodeQr, parseQr } from '../src/modules/collect/collect.lib.js';
import { quoteFx } from '../src/modules/global/fx.lib.js';

describe('QR encode/parse round-trip', () => {
  it('round-trips a till QR with amount', () => {
    const s = encodeQr({ kind: 'till', number: '832909', amountMinor: 50000n, currency: 'KES' });
    expect(s.startsWith('axo://pay?')).toBe(true);
    expect(parseQr(s)).toMatchObject({ kind: 'till', number: '832909', amountMinor: 50000n, currency: 'KES' });
  });
  it('round-trips a paybill QR with account', () => {
    const s = encodeQr({ kind: 'paybill', number: '600921', account: 'RENT' });
    expect(parseQr(s)).toMatchObject({ kind: 'paybill', number: '600921', account: 'RENT' });
  });
  it('rejects a paybill QR with no account', () => {
    expect(parseQr('axo://pay?k=paybill&n=600921')).toBeNull();
  });
  it('rejects non-axo strings', () => {
    expect(parseQr('https://evil.example')).toBeNull();
    expect(parseQr('')).toBeNull();
  });
});

describe('quoteFx', () => {
  it('converts with a disclosed spread', () => {
    // send 100.00 USD at 129 KES/USD, 1% spread
    const q = quoteFx({ sendMinor: 10000n, fromCurrency: 'USD', toCurrency: 'KES', rate: 129, spreadBps: 100, fromDecimals: 2, toDecimals: 2 });
    // effective 100 USD * 129 * 0.99 = 12,771.00 KES -> 1,277,100 minor
    expect(q.receiveMinor).toBe(1277100n);
    expect(q.feeMinor).toBe(100n); // 1% of 10000 minor
    expect(q.spreadBps).toBe(100);
  });
  it('rejects non-positive amount and rate', () => {
    expect(() => quoteFx({ sendMinor: 0n, fromCurrency: 'USD', toCurrency: 'KES', rate: 129 })).toThrow();
    expect(() => quoteFx({ sendMinor: 100n, fromCurrency: 'USD', toCurrency: 'KES', rate: 0 })).toThrow();
  });
  it('handles a sub-1 rate (KES->USD)', () => {
    const q = quoteFx({ sendMinor: 129000n, fromCurrency: 'KES', toCurrency: 'USD', rate: 1 / 129, spreadBps: 0, fromDecimals: 2, toDecimals: 2 });
    // 1290.00 KES / 129 = 10.00 USD -> 1000 minor
    expect(q.receiveMinor).toBe(1000n);
  });
});
