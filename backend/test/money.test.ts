import { describe, it, expect } from 'vitest';
import { toMinor, formatMinor } from '../src/lib/money.js';

describe('money minor-unit conversion (no floats)', () => {
  it('converts 2-decimal amounts exactly', () => {
    expect(toMinor('12.50', 2)).toBe(1250n);
    expect(toMinor('0.01', 2)).toBe(1n);
    expect(toMinor('1000', 2)).toBe(100000n);
    expect(toMinor('0.80', 2)).toBe(80n);
  });

  it('handles the classic float trap 0.1 + 0.2', () => {
    const sum = toMinor('0.10', 2) + toMinor('0.20', 2);
    expect(sum).toBe(30n); // never 0.30000000000000004
  });

  it('handles zero-decimal currencies (KES, UGX)', () => {
    expect(toMinor('103', 0)).toBe(103n);
    expect(toMinor('329', 0)).toBe(329n);
  });

  it('round-trips through formatting', () => {
    expect(formatMinor(1250n, 2)).toBe('12.50');
    expect(formatMinor(80n, 2)).toBe('0.80');
    expect(formatMinor(103n, 0)).toBe('103');
    expect(formatMinor(-4500n, 2)).toBe('-45.00');
  });
});
