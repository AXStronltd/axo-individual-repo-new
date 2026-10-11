import { describe, it, expect } from 'vitest';
import { liveConfigProblems } from '../src/config/env.js';
import { signPayload, verifyPayloadSignature, nextBackoffMs } from '../src/modules/notify/outbox.lib.js';
import { encodeQr, parseQr } from '../src/modules/collect/collect.lib.js';
import { apiKeyPrefix, hashApiKey } from '../src/middleware/auth.js';
import { isClearingTag } from '../src/modules/p2p/p2p.lib.js';
import { buildApp } from '../src/app.js';

const base = {
  APP_ENV: 'live' as const, PORT: 4000, DATABASE_URL: 'postgres://x', REDIS_URL: undefined,
  JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), ARGON2_PEPPER: 'pepper-value-xyz',
  WHATSAPP_VERIFY_TOKEN: 'verify-xyz', WHATSAPP_APP_SECRET: 'app-secret-xyz', WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_TOKEN: undefined,
  RAMP_SANDBOX_SECRET: 'x', MPESA_CONSUMER_KEY: undefined, MPESA_CONSUMER_SECRET: undefined, MPESA_SHORTCODE: undefined,
  MPESA_WEBHOOK_SECRET: undefined, CRYPTO_WEBHOOK_SECRET: undefined, CRYPTO_API_KEY: undefined,
  SANDBOX_WEBHOOK_SECRET: 'sandbox-webhook-secret', OPS_API_KEY: undefined,
};

describe('live config guard (S7)', () => {
  it('accepts a properly configured live deployment', () => {
    expect(liveConfigProblems(base)).toEqual([]);
  });
  it('refuses public default secrets in live', () => {
    const p = liveConfigProblems({ ...base, JWT_SECRET: 'dev-access-secret', WHATSAPP_APP_SECRET: 'dev-app-secret' });
    expect(p.join(' ')).toContain('JWT_SECRET');
    expect(p.join(' ')).toContain('WHATSAPP_APP_SECRET');
  });
  it('refuses short JWT secrets, a missing pepper, and identical access/refresh secrets', () => {
    expect(liveConfigProblems({ ...base, JWT_SECRET: 'short-secret' }).length).toBeGreaterThan(0);
    expect(liveConfigProblems({ ...base, ARGON2_PEPPER: '' }).length).toBeGreaterThan(0);
    expect(liveConfigProblems({ ...base, JWT_REFRESH_SECRET: base.JWT_SECRET }).length).toBeGreaterThan(0);
  });
  it('refuses a short bank webhook secret, but bank collection may be left unconfigured', () => {
    expect(liveConfigProblems({ ...base, BANK_WEBHOOK_SECRET: 'short' }).join(' ')).toContain('BANK_WEBHOOK_SECRET');
    expect(liveConfigProblems({ ...base, BANK_WEBHOOK_SECRET: 'b'.repeat(32) })).toEqual([]);
    expect(liveConfigProblems({ ...base, BANK_WEBHOOK_SECRET: undefined })).toEqual([]);
  });
  it('does not apply in sandbox', () => {
    expect(liveConfigProblems({ ...base, APP_ENV: 'sandbox', JWT_SECRET: 'dev-access-secret' })).toEqual([]);
  });
});

describe('merchant webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"d1","type":"payment.succeeded"}';
  const now = 1_800_000_000;

  it('verifies its own signature', () => {
    expect(verifyPayloadSignature(secret, body, signPayload(secret, body, now), now)).toBe(true);
  });
  it('rejects a tampered body or the wrong secret', () => {
    const sig = signPayload(secret, body, now);
    expect(verifyPayloadSignature(secret, body + ' ', sig, now)).toBe(false);
    expect(verifyPayloadSignature('other', body, sig, now)).toBe(false);
  });
  it('rejects a replay outside the tolerance window', () => {
    const sig = signPayload(secret, body, now);
    expect(verifyPayloadSignature(secret, body, sig, now + 301)).toBe(false);
    expect(verifyPayloadSignature(secret, body, sig, now + 299)).toBe(true);
  });
  it('rejects a re-timestamped signature (the timestamp is signed)', () => {
    const sig = signPayload(secret, body, now).replace(`t=${now}`, `t=${now + 100}`);
    expect(verifyPayloadSignature(secret, body, sig, now + 100)).toBe(false);
  });
  it('rejects missing or malformed headers', () => {
    expect(verifyPayloadSignature(secret, body, undefined, now)).toBe(false);
    expect(verifyPayloadSignature(secret, body, 'garbage', now)).toBe(false);
  });
  it('backs off progressively and caps', () => {
    expect(nextBackoffMs(1)).toBeLessThan(nextBackoffMs(2));
    expect(nextBackoffMs(50)).toBe(nextBackoffMs(7));
  });
});

describe('payment-request QR', () => {
  const ref = 'pr_' + 'A'.repeat(22);
  it('round-trips a request ref', () => {
    expect(parseQr(encodeQr({ kind: 'request', ref }))).toEqual({ kind: 'request', ref });
  });
  it('ignores an amount or currency smuggled into a request QR — the server decides', () => {
    const tampered = encodeQr({ kind: 'request', ref }) + '&amt=1&cur=USD';
    expect(parseQr(tampered)).toEqual({ kind: 'request', ref });
  });
  it('rejects a malformed ref', () => {
    expect(parseQr('axo://pay?k=request&r=push_abc')).toBeNull();
    expect(parseQr('axo://pay?k=request')).toBeNull();
  });
});

describe('API keys and clearing tags', () => {
  it('parses the prefix only from a well-formed key', () => {
    expect(apiKeyPrefix('axo_sk_abcdef123456_' + 'x'.repeat(32))).toBe('abcdef123456');
    expect(apiKeyPrefix('axo_sk_short')).toBeNull();
    expect(apiKeyPrefix('Bearer something')).toBeNull();
  });
  it('hashes deterministically without storing the key', () => {
    expect(hashApiKey('k')).toBe(hashApiKey('k'));
    expect(hashApiKey('k')).not.toContain('k');
  });
  it('recognises the internal clearing wallets', () => {
    expect(isClearingTag('@axo_clearing_kes')).toBe(true);
    expect(isClearingTag('@amina')).toBe(false);
  });
});

describe('service root', () => {
  it('GET / answers with what the service is, not a 404', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'Axo API', status: 'ok', health: '/health' });
    await app.close();
  });
});
