// Money is BigInt in the smallest currency unit. No floats, ever.

export type Minor = bigint;

export function toMinor(value: number | string, decimals = 2): Minor {
  // Convert a human amount (e.g. 12.50) to minor units (1250). String-based to
  // avoid float rounding. decimals = 0 for zero-decimal currencies (KES, UGX).
  const s = String(value).trim();
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const digits = (whole || '0') + fracPadded;
  const n = BigInt(digits.replace(/^0+(?=\d)/, '') || '0');
  return neg ? -n : n;
}

export function formatMinor(amount: Minor, decimals = 2): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : '';
  return (neg ? '-' : '') + whole + frac;
}

// Serialize BigInt safely for JSON responses (JSON has no BigInt).
export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}
