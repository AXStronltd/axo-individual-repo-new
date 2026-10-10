// Pure, DB-free logic for the WhatsApp Cloud API gateway:
//  - GET webhook verification (hub.challenge handshake)
//  - POST signature verification (X-Hub-Signature-256, HMAC-SHA256)
//  - extracting a stable event id for de-duplication
//  - parsing a customer message into an intent
// All testable without network or database.

import crypto from 'node:crypto';

/** Meta's GET verification handshake. Returns the challenge to echo, or null. */
export function verifySubscription(params: {
  mode?: string;
  token?: string;
  challenge?: string;
  verifyToken: string;
}): string | null {
  if (params.mode === 'subscribe' && params.token && params.token === params.verifyToken) {
    return params.challenge ?? '';
  }
  return null;
}

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * Meta signs with sha256=<hex hmac of the raw body using the app secret>.
 * Uses a constant-time comparison. Never trust a webhook that fails this.
 */
export function verifySignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  // timingSafeEqual throws on length mismatch, so guard first.
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface InboundMessage {
  eventId: string;     // stable id for de-dup (the WA message id)
  waId: string;        // sender's WhatsApp number (digits)
  text: string;        // message body (button payloads normalized to text)
  timestamp?: string;
}

/**
 * Extract the first message from a Cloud API webhook payload. Returns null for
 * non-message events (status callbacks, etc.). Button/interactive replies are
 * flattened to their id/title so the router handles them like text.
 */
export function extractMessage(payload: any): InboundMessage | null {
  try {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return null;
    const waId: string = msg.from;
    let text = '';
    if (msg.type === 'text') text = msg.text?.body ?? '';
    else if (msg.type === 'interactive') {
      const i = msg.interactive;
      text = i?.button_reply?.id ?? i?.button_reply?.title ?? i?.list_reply?.id ?? i?.list_reply?.title ?? '';
    } else if (msg.type === 'button') {
      text = msg.button?.payload ?? msg.button?.text ?? '';
    }
    if (!msg.id || !waId) return null;
    return { eventId: msg.id, waId, text: String(text).trim(), timestamp: msg.timestamp };
  } catch {
    return null;
  }
}

export type Intent =
  | { kind: 'register' }
  | { kind: 'verify'; code: string }
  | { kind: 'balance' }
  | { kind: 'send'; amount: string; to: string; note?: string }
  | { kind: 'pay_till'; till: string; amount: string }
  | { kind: 'pay_bill'; paybill: string; account: string; amount: string }
  | { kind: 'send_phone'; amount: string; phone: string; note?: string }
  | { kind: 'recall'; code: string }
  | { kind: 'claim'; code: string }
  | { kind: 'setpin'; pin: string }
  | { kind: 'pin'; pin: string }
  | { kind: 'mini' }
  | { kind: 'receive_crypto' }
  | { kind: 'send_global'; amount: string; toCurrency: string; dest: string }
  | { kind: 'withdraw'; agent: string; amount: string }
  | { kind: 'airtime'; amount: string; phone?: string }
  | { kind: 'bill'; biller: string; account: string; amount: string }
  | { kind: 'request'; amount: string; from: string; note?: string }
  | { kind: 'reverse_txn'; ref: string }
  | { kind: 'changepin'; oldPin: string; newPin: string }
  | { kind: 'history' }
  | { kind: 'help' }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'unknown'; text: string };

/**
 * Parse a customer's chat line into an intent. Deliberately forgiving and
 * multi-lingual on the key verbs (English, Swahili, Somali) since the audience
 * types naturally. The router decides what state each intent is valid in.
 */
export function parseIntent(text: string): Intent {
  const t = (text || '').trim();
  const l = t.toLowerCase();
  if (!l) return { kind: 'unknown', text: t };

  if (/^(register|signup|sign up|join|anza|diiwaangeli)\b/.test(l)) return { kind: 'register' };
  if (/^(help|menu|msaada|caawin)\b/.test(l)) return { kind: 'help' };
  if (/^(balance|bal|salio|hadhaaga|hadhaag)\b/.test(l)) return { kind: 'balance' };
  if (/^(history|statement|historia|taariikh)\b/.test(l)) return { kind: 'history' };
  if (/^(mini|ministatement|mini-statement)\b/.test(l)) return { kind: 'mini' };
  // receive crypto  |  crypto  |  receive usdc
  if (/^(receive crypto|crypto|receive usdc|usdc|usdt)\b/.test(l)) return { kind: 'receive_crypto' };
  // changepin 1234 5678  |  change pin 1234 5678
  const cp = l.match(/^change ?pin\s+(\d{4,6})\s+(\d{4,6})$/);
  if (cp) return { kind: 'changepin', oldPin: cp[1]!, newPin: cp[2]! };
  // withdraw 1000 from AG1  |  withdraw 1000 at amran  |  toa 1000 (Swahili) from AG1
  const wd = l.match(/^(?:withdraw|cashout|cash out|toa|ka ?qaad)\s+([\d,]+(?:\.\d+)?)\s+(?:from|at|kwa|agent)\s+(\S+)$/);
  if (wd) return { kind: 'withdraw', amount: wd[1]!.replace(/,/g, ''), agent: wd[2]!.toUpperCase() };
  // airtime 100  |  airtime 100 +254711  |  buy airtime 50  |  topup 20
  const ar = l.match(/^(?:buy ?airtime|airtime|top ?up|data|bando)\s+([\d,]+(?:\.\d+)?)(?:\s+(\+?\d[\d ]{6,}))?$/);
  if (ar) return { kind: 'airtime', amount: ar[1]!.replace(/,/g, ''), phone: ar[2]?.replace(/\s/g, '') };
  // bill power 123456 500  |  pay bill water ACC12 300  (type given explicitly)
  const bl = l.match(/^(?:bill|pay ?bill utility|utility|lipa bill)\s+(\S+)\s+(\S+)\s+([\d,]+(?:\.\d+)?)$/);
  if (bl) return { kind: 'bill', biller: bl[1]!.toLowerCase(), account: bl[2]!.toUpperCase(), amount: bl[3]!.replace(/,/g, '') };
  // token 123456 500  (keyword implies electricity)  |  power 123456 500
  const tk = l.match(/^(?:token|power|electric(?:ity)?|kplc|umeme)\s+(\S+)\s+([\d,]+(?:\.\d+)?)$/);
  if (tk) return { kind: 'bill', biller: 'electricity', account: tk[1]!.toUpperCase(), amount: tk[2]!.replace(/,/g, '') };
  // request 500 from @amina [for lunch]  |  ask 500 from @x
  const rq = l.match(/^(?:request|ask|omba|codso)\s+([\d,]+(?:\.\d+)?)\s+from\s+(\S+)(?:\s+(?:for|note)\s+(.+))?$/);
  if (rq) return { kind: 'request', amount: rq[1]!.replace(/,/g, ''), from: rq[2]!, note: rq[3]?.trim() };
  // reverse TXN-1234  (a completed send, within the window)
  const rv = l.match(/^(?:reverse|undo)\s+(txn-?\w+)$/i);
  if (rv) return { kind: 'reverse_txn', ref: rv[1]!.toUpperCase() };
  // global 100 usdc to 0xabc  |  send global 50 eur to IBAN123  |  sendglobal 20 usd to +44…
  // match on the lowercased text but take the destination from the ORIGINAL (a
  // wallet address or IBAN is case-sensitive, so it must not be lowercased).
  const gl = l.match(/^(?:send ?global|global|send abroad)\s+([\d,]+(?:\.\d+)?)\s+([a-z]{3,4})\s+to\s+(\S+)$/);
  if (gl) {
    const destMatch = t.match(/\bto\s+(\S+)\s*$/i);
    const dest = destMatch ? destMatch[1]! : gl[3]!;
    return { kind: 'send_global', amount: gl[1]!.replace(/,/g, ''), toCurrency: gl[2]!.toUpperCase(), dest };
  }

  // setpin 1234  |  set pin 1234
  const spin = l.match(/^set ?pin\s+(\d{4,6})$/);
  if (spin) return { kind: 'setpin', pin: spin[1]! };
  // pin 1234  (a standalone PIN entry when prompted for step-up)
  const pin = l.match(/^pin\s+(\d{4,6})$/);
  if (pin) return { kind: 'pin', pin: pin[1]! };
  // claim CLM-000123  (recipient receiving a send-to-unregistered)
  const cl = l.match(/^claim\s+clm-?(\d{6})$/i);
  if (cl) return { kind: 'claim', code: 'CLM-' + cl[1] };
  // recall CLM-000123  |  reverse CLM-000123
  const rc = l.match(/^(?:recall|reverse|rudisha)\s+clm-?(\d{6})$/i);
  if (rc) return { kind: 'recall', code: 'CLM-' + rc[1] };
  // sendto +254711 500  |  send to +254711 500  (pay a phone, registered or not)
  const sp = l.match(/^send ?to\s+(\+?\d[\d ]{6,})\s+([\d,]+(?:\.\d+)?)(?:\s+(?:for|note)\s+(.+))?$/);
  if (sp) return { kind: 'send_phone', phone: sp[1]!.replace(/\s/g, ''), amount: sp[2]!.replace(/,/g, ''), note: sp[3]?.trim() };
  if (/^(yes|y|confirm|approve|haa|ndiyo|sí|si)\b/.test(l)) return { kind: 'confirm' };
  if (/^(no|n|cancel|stop|hapana|maya|jooji)\b/.test(l)) return { kind: 'cancel' };

  // verify 123456  |  code 123456  |  just a bare 4-8 digit code
  const vm = l.match(/^(?:verify|code|xaqiiji)\s+(\d{4,8})$/) || l.match(/^(\d{4,8})$/);
  if (vm) return { kind: 'verify', code: vm[1]! };

  // PAY A BUSINESS — the M-Pesa-equivalent flows, done over WhatsApp.
  // Paybill (account-based): "paybill 600921 RENT 5000" | "lipa 600921 acct RENT 5000"
  const pb = l.match(/^(?:paybill|pay ?bill|lipa namba|bill)\s+(\d[\d ]{3,})\s+(?:a\/?c\s+|acct\s+|account\s+)?(\S+)\s+([\d,]+(?:\.\d+)?)$/);
  if (pb) return { kind: 'pay_bill', paybill: pb[1]!.replace(/\s/g, ''), account: pb[2]!.toUpperCase(), amount: pb[3]!.replace(/,/g, '') };
  // Till / Buy Goods: "till 832909 500" | "pay till 832909 500" | "buygoods 832909 500"
  const tl = l.match(/^(?:pay\s+)?(?:till|buy ?goods|lipa till|duka)\s+(\d[\d ]{3,})\s+([\d,]+(?:\.\d+)?)$/);
  if (tl) return { kind: 'pay_till', till: tl[1]!.replace(/\s/g, ''), amount: tl[2]!.replace(/,/g, '') };

  // send 500 to @amina [for lunch]   |   tuma 500 kwa @amina   |   dir 500
  const sm = l.match(/^(?:send|pay|tuma|lipa|dir|bixi)\s+([\d,]+(?:\.\d+)?)\s+(?:to|kwa|u|ku)\s+(\S+)(?:\s+(?:for|kwa ajili|note)\s+(.+))?$/);
  if (sm) return { kind: 'send', amount: sm[1]!.replace(/,/g, ''), to: sm[2]!, note: sm[3]?.trim() };

  return { kind: 'unknown', text: t };
}

/**
 * Should an unknown WhatsApp number (no Axo wallet yet) be taken through
 * first-contact onboarding for this intent, instead of being turned away?
 * True only for intents that are an attempt to PAY A BUSINESS — so anyone with
 * WhatsApp can pay like an M-Pesa user, with the wallet created on the spot.
 */
export function shouldOnboardForPayment(intent: Intent): boolean {
  return intent.kind === 'pay_till' || intent.kind === 'pay_bill';
}

/** Generate a numeric OTP of the given length. Cryptographically random. */
export function generateOtp(length = 6): string {
  let s = '';
  while (s.length < length) s += crypto.randomInt(0, 10).toString();
  return s.slice(0, length);
}
