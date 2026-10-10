import { describe, it, expect } from 'vitest';
import { formatMiniStatement, previewFee } from '../src/modules/p2p/statement.lib.js';
import { isValidPinFormat } from '../src/modules/p2p/pin.service.js';
import { parseIntent } from '../src/modules/whatsapp/whatsapp.lib.js';

describe('mini-statement', () => {
  it('formats recent rows M-Pesa-style', () => {
    const s = formatMiniStatement([
      { direction: 'out', amountMinor: 500n, status: 'completed', note: 'pay @juma' },
      { direction: 'in', amountMinor: 1200n, status: 'completed' },
    ], 'KES', 0);
    expect(s).toContain('− KES 500');
    expect(s).toContain('+ KES 1200');
  });
  it('handles no transactions', () => {
    expect(formatMiniStatement([], 'KES')).toBe('No transactions yet.');
  });
});

describe('previewFee (show cost before confirm)', () => {
  it('is free for Axo-to-Axo and pay-business', () => {
    expect(previewFee({ kind: 'p2p', amountMinor: 10000n }).feeMinor).toBe(0n);
    expect(previewFee({ kind: 'pay_business', amountMinor: 10000n }).disclosed).toMatch(/free/i);
  });
  it('discloses a 1% fee on cash-out / global', () => {
    const f = previewFee({ kind: 'cash_out', amountMinor: 10000n });
    expect(f.feeMinor).toBe(100n);
    expect(f.totalMinor).toBe(10100n);
    expect(f.disclosed).toMatch(/1\.00%/);
  });
});

describe('PIN format', () => {
  it('accepts 4–6 digits', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('123456')).toBe(true);
  });
  it('rejects bad PINs', () => {
    expect(isValidPinFormat('12')).toBe(false);
    expect(isValidPinFormat('abcd')).toBe(false);
    expect(isValidPinFormat('1234567')).toBe(false);
  });
});

describe('new WhatsApp intents (Phase 10)', () => {
  it('parses SENDTO a phone (registered or not)', () => {
    expect(parseIntent('sendto +254711222333 500')).toMatchObject({ kind: 'send_phone', phone: '+254711222333', amount: '500' });
    expect(parseIntent('send to 254711222333 1,000 for rent')).toMatchObject({ kind: 'send_phone', amount: '1000', note: 'rent' });
  });
  it('parses CLAIM and RECALL codes', () => {
    expect(parseIntent('claim CLM-000123')).toMatchObject({ kind: 'claim', code: 'CLM-000123' });
    expect(parseIntent('claim clm123456')).toMatchObject({ kind: 'claim', code: 'CLM-123456' });
    expect(parseIntent('recall CLM-000123')).toMatchObject({ kind: 'recall', code: 'CLM-000123' });
  });
  it('parses SETPIN and standalone PIN', () => {
    expect(parseIntent('setpin 1234')).toMatchObject({ kind: 'setpin', pin: '1234' });
    expect(parseIntent('set pin 123456')).toMatchObject({ kind: 'setpin', pin: '123456' });
    expect(parseIntent('pin 4321')).toMatchObject({ kind: 'pin', pin: '4321' });
  });
  it('parses MINI statement', () => {
    expect(parseIntent('mini').kind).toBe('mini');
  });
  it('does not mistake SEND to @tag for SENDTO a phone', () => {
    expect(parseIntent('send 500 to @amina').kind).toBe('send');
  });
});
