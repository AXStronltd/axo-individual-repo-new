import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifySubscription,
  verifySignature,
  extractMessage,
  parseIntent,
  generateOtp,
  shouldOnboardForPayment,
} from '../src/modules/whatsapp/whatsapp.lib.js';

describe('webhook subscription handshake', () => {
  it('echoes the challenge on a correct token', () => {
    expect(verifySubscription({ mode: 'subscribe', token: 'secret', challenge: '12345', verifyToken: 'secret' })).toBe('12345');
  });
  it('rejects a wrong token', () => {
    expect(verifySubscription({ mode: 'subscribe', token: 'nope', challenge: '1', verifyToken: 'secret' })).toBeNull();
  });
});

describe('signature verification (HMAC-SHA256)', () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts a valid signature', () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifySignature(body + 'x', sig, secret)).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(verifySignature(body, sig, 'other')).toBe(false);
  });
  it('rejects a missing/garbage header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=zzzz', secret)).toBe(false);
  });
});

describe('extractMessage (de-dup key)', () => {
  const payload = (id: string, from: string, text: string) => ({
    entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body: text } }] } }] }],
  });
  it('pulls id, sender and text', () => {
    const m = extractMessage(payload('wamid.1', '254712', 'SEND 500 to @amina'));
    expect(m).toMatchObject({ eventId: 'wamid.1', waId: '254712', text: 'SEND 500 to @amina' });
  });
  it('returns null for non-message events', () => {
    expect(extractMessage({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toBeNull();
  });
  it('flattens an interactive button reply to text', () => {
    const p = { entry: [{ changes: [{ value: { messages: [{ id: 'x', from: '254', type: 'interactive', interactive: { button_reply: { id: 'confirm', title: 'Yes' } } }] } }] }] };
    expect(extractMessage(p)?.text).toBe('confirm');
  });
});

describe('parseIntent', () => {
  it('parses register/help/balance/history', () => {
    expect(parseIntent('register').kind).toBe('register');
    expect(parseIntent('HELP').kind).toBe('help');
    expect(parseIntent('balance').kind).toBe('balance');
    expect(parseIntent('history').kind).toBe('history');
  });
  it('parses a verify code (with or without keyword)', () => {
    expect(parseIntent('verify 123456')).toMatchObject({ kind: 'verify', code: '123456' });
    expect(parseIntent('123456')).toMatchObject({ kind: 'verify', code: '123456' });
  });
  it('parses an English send', () => {
    expect(parseIntent('send 500 to @amina for lunch')).toMatchObject({ kind: 'send', amount: '500', to: '@amina', note: 'lunch' });
  });
  it('parses a Swahili send', () => {
    expect(parseIntent('tuma 1000 kwa @juma')).toMatchObject({ kind: 'send', amount: '1000', to: '@juma' });
  });
  it('parses a Somali send', () => {
    expect(parseIntent('dir 250 u @cali')).toMatchObject({ kind: 'send', amount: '250', to: '@cali' });
  });
  it('parses paying a Till (Buy Goods)', () => {
    expect(parseIntent('till 832909 500')).toMatchObject({ kind: 'pay_till', till: '832909', amount: '500' });
    expect(parseIntent('pay till 8329 09 500')).toMatchObject({ kind: 'pay_till', till: '832909', amount: '500' });
    expect(parseIntent('buygoods 832909 1,250')).toMatchObject({ kind: 'pay_till', till: '832909', amount: '1250' });
  });
  it('parses paying a Paybill with an account number', () => {
    expect(parseIntent('paybill 600921 RENT 5000')).toMatchObject({ kind: 'pay_bill', paybill: '600921', account: 'RENT', amount: '5000' });
    expect(parseIntent('paybill 600 921 acct unit12 3000')).toMatchObject({ kind: 'pay_bill', paybill: '600921', account: 'UNIT12', amount: '3000' });
  });
  it('does not confuse "send 500 to @x" with a till payment', () => {
    expect(parseIntent('send 500 to @amina').kind).toBe('send');
  });
  it('falls back to unknown', () => {
    expect(parseIntent('what is the weather').kind).toBe('unknown');
  });
});

describe('symmetry intents (crypto + global on the individual side)', () => {
  it('parses RECEIVE CRYPTO', () => {
    expect(parseIntent('crypto').kind).toBe('receive_crypto');
    expect(parseIntent('receive crypto').kind).toBe('receive_crypto');
    expect(parseIntent('usdc').kind).toBe('receive_crypto');
  });
  it('parses SEND GLOBAL with destination currency', () => {
    expect(parseIntent('global 100 USD to 0xabc123')).toMatchObject({ kind: 'send_global', amount: '100', toCurrency: 'USD', dest: '0xabc123' });
    expect(parseIntent('send global 50 eur to IBAN99')).toMatchObject({ kind: 'send_global', amount: '50', toCurrency: 'EUR', dest: 'IBAN99' });
  });
});

describe('everyday M-Pesa/EVC parity intents (individual)', () => {
  it('parses WITHDRAW at an agent (Amran)', () => {
    expect(parseIntent('withdraw 1000 from AMRAN')).toMatchObject({ kind: 'withdraw', amount: '1000', agent: 'AMRAN' });
    expect(parseIntent('cashout 500 at ag1')).toMatchObject({ kind: 'withdraw', amount: '500', agent: 'AG1' });
  });
  it('parses BUY AIRTIME, with and without a phone', () => {
    expect(parseIntent('airtime 100')).toMatchObject({ kind: 'airtime', amount: '100' });
    expect(parseIntent('buy airtime 50 +254711222333')).toMatchObject({ kind: 'airtime', amount: '50', phone: '+254711222333' });
  });
  it('parses PAY A UTILITY BILL', () => {
    expect(parseIntent('bill power 123456 500')).toMatchObject({ kind: 'bill', biller: 'power', account: '123456', amount: '500' });
    expect(parseIntent('token 654321 1000')).toMatchObject({ kind: 'bill', amount: '1000' });
  });
  it('parses REQUEST money', () => {
    expect(parseIntent('request 500 from @amina for lunch')).toMatchObject({ kind: 'request', amount: '500', from: '@amina', note: 'lunch' });
  });
  it('parses REVERSE and CHANGEPIN', () => {
    expect(parseIntent('reverse TXN-4821')).toMatchObject({ kind: 'reverse_txn', ref: 'TXN-4821' });
    expect(parseIntent('changepin 1234 5678')).toMatchObject({ kind: 'changepin', oldPin: '1234', newPin: '5678' });
  });
  it('does not confuse a utility bill with a merchant paybill', () => {
    expect(parseIntent('paybill 600921 RENT 5000').kind).toBe('pay_bill');
  });
});

describe('first-contact onboarding (anyone with WhatsApp can pay)', () => {
  it('onboards an unknown number that tries to pay a Till or Paybill', () => {
    expect(shouldOnboardForPayment(parseIntent('till 832909 500'))).toBe(true);
    expect(shouldOnboardForPayment(parseIntent('paybill 600921 RENT 5000'))).toBe(true);
  });
  it('does NOT onboard for non-payment intents (balance, help, send-to-tag)', () => {
    expect(shouldOnboardForPayment(parseIntent('balance'))).toBe(false);
    expect(shouldOnboardForPayment(parseIntent('help'))).toBe(false);
    expect(shouldOnboardForPayment(parseIntent('send 500 to @amina'))).toBe(false);
  });
});

describe('generateOtp', () => {
  it('produces a 6-digit numeric code', () => {
    const code = generateOtp(6);
    expect(code).toMatch(/^\d{6}$/);
  });
  it('is not trivially constant', () => {
    const a = new Set(Array.from({ length: 20 }, () => generateOtp(6)));
    expect(a.size).toBeGreaterThan(1);
  });
});
