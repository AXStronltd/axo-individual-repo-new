import crypto from 'node:crypto';

/**
 * Pure helpers for bank collection (Phase 16): which collection accounts exist,
 * deposit references, and the bank webhook signature. No database access here.
 */

/** Where a customer sends a bank transfer to top up. Comes from configuration only. */
export interface CollectionAccount {
  bankName: string;        // e.g. "Galaxy Bank"
  accountName: string;     // the account holder customers see on their transfer
  accountNumber: string;
  network?: string;        // e.g. "Any Somali bank · RTGS"
  currencies?: string[];   // ISO-4217; omitted ⇒ any currency
}

/** Shown in sandbox when no accounts are configured — labelled so nobody sends real money. */
export const SANDBOX_ACCOUNT: CollectionAccount = {
  bankName: 'Sandbox Bank (not a real bank)',
  accountName: 'Axo Sandbox',
  accountNumber: 'SANDBOX-000000',
  network: 'Sandbox only. Do not send real money.',
};

/**
 * The configured collection accounts, keyed by lower-case bank code. Reads
 * BANK_COLLECTION_ACCOUNTS (JSON). Unset in sandbox ⇒ one sandbox account; unset
 * in live ⇒ none, so bank top-ups are refused instead of pointing customers at
 * an account that doesn't exist. Malformed entries are dropped, not guessed at.
 */
export function collectionAccounts(raw: string | undefined, appEnv: string): Record<string, CollectionAccount> {
  if (!raw) return appEnv === 'live' ? {} : { sandbox: SANDBOX_ACCOUNT };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, CollectionAccount> = {};
  for (const [code, v] of Object.entries(parsed as Record<string, any>)) {
    if (!/^[a-z0-9_-]{2,32}$/i.test(code) || !v || typeof v !== 'object') continue;
    const { bankName, accountName, accountNumber, network, currencies } = v;
    if (![bankName, accountName, accountNumber].every((x) => typeof x === 'string' && x.trim())) continue;
    out[code.toLowerCase()] = {
      bankName, accountName, accountNumber,
      ...(typeof network === 'string' ? { network } : {}),
      ...(Array.isArray(currencies) ? { currencies: currencies.map((c: unknown) => String(c).toUpperCase()) } : {}),
    };
  }
  return out;
}

export function accountAccepts(account: CollectionAccount, currency: string): boolean {
  return !account.currencies || account.currencies.includes(currency.toUpperCase());
}

/** Short, human-quotable reference, e.g. AXO-GALA-042917. Uniqueness is enforced by the DB. */
export function depositReference(bank: string): string {
  const tag = bank.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'BANK';
  return 'AXO-' + tag + '-' + crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Normalise what a customer or bank typed: case, spaces and dashes don't matter. */
export function normalizeReference(ref: string): string {
  const s = ref.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^AXO([A-Z0-9]{1,4}?)(\d{6})$/.exec(s);
  return m ? `AXO-${m[1]}-${m[2]}` : ref.trim().toUpperCase();
}

/** Signature the collection bank sends: "sha256=" + hex HMAC-SHA256 of the raw body. */
export function signBankWebhook(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time check of a bank webhook signature. */
export function verifyBankSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(signBankWebhook(rawBody, secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
