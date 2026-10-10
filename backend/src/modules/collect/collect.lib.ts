// Pure, DB-free helpers for the collection surfaces:
//  - QR payload encode/parse (what a customer's Axo app scans to know who to pay)
//  - push-prompt (STK-style) target parsing
// Testable without a database or network.

export interface PayTarget {
  kind: 'till' | 'paybill' | 'tag';
  number?: string;   // till/paybill number
  account?: string;  // paybill account line
  tag?: string;      // @handle
  amountMinor?: bigint; // optional pre-filled amount
  currency?: string;
}

// A compact, URL-safe QR string: axo://pay?... The customer's Axo scans this and
// is shown a confirm prompt. Deterministic, so it round-trips in tests.
export function encodeQr(t: PayTarget): string {
  const p = new URLSearchParams();
  p.set('k', t.kind);
  if (t.number) p.set('n', t.number);
  if (t.account) p.set('a', t.account);
  if (t.tag) p.set('t', t.tag);
  if (t.amountMinor != null) p.set('amt', t.amountMinor.toString());
  if (t.currency) p.set('cur', t.currency);
  return 'axo://pay?' + p.toString();
}

export function parseQr(s: string): PayTarget | null {
  if (!s || !s.startsWith('axo://pay?')) return null;
  const p = new URLSearchParams(s.slice('axo://pay?'.length));
  const kind = p.get('k');
  if (kind !== 'till' && kind !== 'paybill' && kind !== 'tag') return null;
  const t: PayTarget = { kind };
  const n = p.get('n'); if (n) t.number = n;
  const a = p.get('a'); if (a) t.account = a.toUpperCase();
  const tag = p.get('t'); if (tag) t.tag = tag.toLowerCase();
  const amt = p.get('amt'); if (amt && /^\d+$/.test(amt)) t.amountMinor = BigInt(amt);
  const cur = p.get('cur'); if (cur) t.currency = cur.toUpperCase();
  // a paybill QR must carry an account; a tag QR must carry a tag
  if (kind === 'paybill' && !t.account) return null;
  if (kind === 'tag' && !t.tag) return null;
  if ((kind === 'till' || kind === 'paybill') && !t.number) return null;
  return t;
}

// A push-prompt reference the customer approves (like an STK CheckoutRequestID).
export function makePushRef(): string {
  return 'push_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
