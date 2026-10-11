import { describe, it, expect } from 'vitest';
import {
  accountAccepts, collectionAccounts, depositReference, normalizeReference,
  signBankWebhook, verifyBankSignature, SANDBOX_ACCOUNT,
} from '../src/modules/cash/bank.lib.js';

describe('bank collection — collection accounts come from configuration only', () => {
  it('sandbox without config offers one clearly-labelled sandbox account', () => {
    expect(collectionAccounts(undefined, 'sandbox')).toEqual({ sandbox: SANDBOX_ACCOUNT });
    expect(SANDBOX_ACCOUNT.network).toMatch(/do not send real money/i);
  });

  it('live without config offers none — never an invented account', () => {
    expect(collectionAccounts(undefined, 'live')).toEqual({});
  });

  it('parses configured accounts and drops malformed ones', () => {
    const raw = JSON.stringify({
      Galaxy: { bankName: 'Galaxy Bank', accountName: 'Axo Ltd', accountNumber: '100200', network: 'RTGS', currencies: ['usd'] },
      broken: { bankName: 'No number' },
      'bad code!': { bankName: 'x', accountName: 'y', accountNumber: 'z' },
    });
    const a = collectionAccounts(raw, 'live');
    const galaxy = a.galaxy!;
    expect(Object.keys(a)).toEqual(['galaxy']);
    expect(galaxy.currencies).toEqual(['USD']);
    expect(accountAccepts(galaxy, 'USD')).toBe(true);
    expect(accountAccepts(galaxy, 'KES')).toBe(false);
    expect(accountAccepts(SANDBOX_ACCOUNT, 'KES')).toBe(true);
  });

  it('unparseable config yields no accounts', () => {
    expect(collectionAccounts('{not json', 'sandbox')).toEqual({});
  });
});

describe('bank collection — references', () => {
  it('are short and quotable: AXO-<BANK>-<6 digits>', () => {
    expect(depositReference('galaxy')).toMatch(/^AXO-GALA-\d{6}$/);
    expect(depositReference('sandbox')).toMatch(/^AXO-SAND-\d{6}$/);
  });

  it('match however the customer or bank typed them', () => {
    expect(normalizeReference('axo gala 042917')).toBe('AXO-GALA-042917');
    expect(normalizeReference('AXO-GALA-042917')).toBe('AXO-GALA-042917');
    expect(normalizeReference('axogala042917')).toBe('AXO-GALA-042917');
  });
});

describe('bank collection — webhook signature', () => {
  const secret = 'x'.repeat(40);
  const body = JSON.stringify({ reference: 'AXO-GALA-000001', amountMinor: '500', currency: 'USD', bankRef: 'T1' });

  it('accepts the bank’s signature over the exact raw body', () => {
    expect(verifyBankSignature(body, signBankWebhook(body, secret), secret)).toBe(true);
  });

  it('rejects a changed body, a wrong secret, or no signature', () => {
    expect(verifyBankSignature(body.replace('500', '900'), signBankWebhook(body, secret), secret)).toBe(false);
    expect(verifyBankSignature(body, signBankWebhook(body, 'y'.repeat(40)), secret)).toBe(false);
    expect(verifyBankSignature(body, '', secret)).toBe(false);
  });
});
