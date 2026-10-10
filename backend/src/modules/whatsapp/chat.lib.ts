// Pure, DB-free helpers for a friendlier, safer chat — testable without a DB.

// Minor-unit decimals by currency — THE single rule for money units.
// Decision (Oct 2026): KES, UGX, TZS, RWF and SOS are held and shown in whole
// units (1 minor unit = 1 shilling, no cents). Every other currency uses its
// normal 2 decimals — USD in cents. Somalia transacts in USD, so a Somali
// wallet is USD in cents. Extend this set as markets are added; never format
// money with a hard-coded decimal count elsewhere.
const ZERO_DECIMAL = new Set(['KES', 'UGX', 'TZS', 'RWF', 'SOS']);
export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has((currency || '').toUpperCase()) ? 0 : 2;
}

/** Parse a human amount string into minor units for the given currency. */
export function amountToMinor(amount: string, currency: string): bigint | null {
  const dec = currencyDecimals(currency);
  const s = (amount || '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  // More precision than the currency has (KES 12.50, USD 5.555) is refused, not
  // rounded: silently paying a different amount than the person typed is worse
  // than asking again. Trailing zeros are fine (KES 12.00).
  if (frac.replace(/0+$/, '').length > dec) return null;
  const fracPadded = (frac + '0'.repeat(dec)).slice(0, dec);
  const minor = BigInt((whole || '0') + (dec > 0 ? fracPadded : ''));
  return minor > 0n ? minor : null;
}

/** Format minor units back to a display string for the currency. */
export function formatAmount(minor: bigint, currency: string): string {
  const dec = currencyDecimals(currency);
  const neg = minor < 0n; const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(dec + 1, '0');
  const whole = s.slice(0, s.length - dec) || '0';
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = dec > 0 ? '.' + s.slice(s.length - dec) : '';
  return `${currency} ${neg ? '-' : ''}${withSep}${frac}`;
}

/**
 * When a message doesn't match a command, try to detect loosely what the person
 * WANTS and return a gentle nudge toward the right command — instead of a flat
 * "I didn't catch that". Returns null if we truly can't tell. Multi-lingual on
 * the common verbs (English, Swahili, Somali).
 */
export function coachUnknown(text: string): string | null {
  const l = (text || '').toLowerCase();
  if (!l.trim()) return null;

  // wants to send money
  if (/\b(send|sending|transfer|tuma|kutuma|dir|bixi|lacag ?dir|wixii)\b/.test(l) && !/\b(till|paybill|business|biashara)\b/.test(l)) {
    return 'To send money, reply:\n• SEND <amount> to @tag  (to an Axo user)\n• SENDTO <phone> <amount>  (to anyone)';
  }
  // wants to pay a business
  if (/\b(pay|paying|buy|duka|biashara|business|shop|till|paybill)\b/.test(l)) {
    return 'To pay a business, reply:\n• TILL <number> <amount>\n• PAYBILL <number> <account> <amount>';
  }
  // wants their balance
  if (/\b(how much|balance|money|do i have|nina|pesa ngapi|lacagta|ngapi)\b/.test(l)) {
    return 'To see your balance, just reply BALANCE.';
  }
  // wants history
  if (/\b(history|statement|transactions|last|recent|taariikh|historia)\b/.test(l)) {
    return 'For your recent transactions, reply MINI or HISTORY.';
  }
  // greetings / lost
  if (/\b(hi|hello|hey|start|habari|salaan|iska warran|mambo)\b/.test(l)) {
    return null; // let the menu handle greetings
  }
  return null;
}

/** Infer a new wallet's country + currency from its phone prefix. Somalia (+252) = USD. */
export function countryCurrencyFor(digits: string): { country: string; currency: string } {
  if (digits.startsWith('252')) return { country: 'SO', currency: 'USD' }; // Somalia uses USD
  if (digits.startsWith('255')) return { country: 'TZ', currency: 'TZS' };
  if (digits.startsWith('256')) return { country: 'UG', currency: 'UGX' };
  if (digits.startsWith('254')) return { country: 'KE', currency: 'KES' };
  return { country: 'KE', currency: 'KES' }; // default
}
