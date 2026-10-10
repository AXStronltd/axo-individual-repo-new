import { describe, it, expect } from 'vitest';
import { amountToMinor, formatAmount, currencyDecimals, coachUnknown } from '../src/modules/whatsapp/chat.lib.js';

describe('per-user currency amount parsing', () => {
  it('KES is zero-decimal', () => {
    expect(currencyDecimals('KES')).toBe(0);
    expect(amountToMinor('500', 'KES')).toBe(500n);
    expect(amountToMinor('1,250', 'KES')).toBe(1250n);
    expect(formatAmount(1250n, 'KES')).toBe('KES 1,250');
  });
  it('USD is two-decimal (Somalia uses USD)', () => {
    expect(currencyDecimals('USD')).toBe(2);
    expect(amountToMinor('5', 'USD')).toBe(500n);       // 5.00 USD
    expect(amountToMinor('5.50', 'USD')).toBe(550n);
    expect(formatAmount(550n, 'USD')).toBe('USD 5.50');
  });
  it('SOS treated as zero-decimal, Somalia default is USD at provisioning', () => {
    expect(currencyDecimals('SOS')).toBe(0);
  });
  it('rejects junk and non-positive amounts', () => {
    expect(amountToMinor('abc', 'KES')).toBeNull();
    expect(amountToMinor('0', 'KES')).toBeNull();
    expect(amountToMinor('-5', 'USD')).toBeNull();
  });
  it('formats thousands separators', () => {
    expect(formatAmount(1234567n, 'KES')).toBe('KES 1,234,567');
    expect(formatAmount(123456n, 'USD')).toBe('USD 1,234.56');
  });
});

describe('coachUnknown — friendlier fallback', () => {
  it('guides a vague send request', () => {
    expect(coachUnknown('i want to send money')).toMatch(/SEND/);
    expect(coachUnknown('nataka kutuma')).toMatch(/SEND/);
  });
  it('guides a pay-a-business request', () => {
    expect(coachUnknown('how do i pay a shop')).toMatch(/TILL|PAYBILL/);
  });
  it('guides a balance request', () => {
    expect(coachUnknown('how much do i have')).toMatch(/BALANCE/);
    expect(coachUnknown('pesa ngapi')).toMatch(/BALANCE/);
  });
  it('guides a history request', () => {
    expect(coachUnknown('show my recent transactions')).toMatch(/MINI|HISTORY/);
  });
  it('returns null for greetings (menu handles those) and true gibberish', () => {
    expect(coachUnknown('hello')).toBeNull();
    expect(coachUnknown('asdfghjkl')).toBeNull();
  });
});
