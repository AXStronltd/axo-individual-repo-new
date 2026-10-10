import { createHmac } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentProvider, PayoutRequest, PayoutResult, WebhookVerification } from './types.js';

const SANDBOX_SECRET = 'sandbox-webhook-secret';

/**
 * Deterministic sandbox provider. createCharge returns `accepted` only — it does
 * NOT confirm money. A separate webhook (which a test or a sandbox timer fires)
 * carries the real outcome, exactly like a live provider. This lets the whole
 * request -> pending -> webhook -> confirmed -> ledger path run without real money.
 */
export const sandboxProvider: PaymentProvider = {
  name: 'sandbox',

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    return { providerRef: `sbx_${req.reference}`, status: 'accepted' };
  },

  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    return { providerRef: `sbx_po_${req.reference}`, status: 'accepted' };
  },

  parseWebhook(headers: Record<string, string>, rawBody: string): WebhookVerification {
    const sig = headers['x-sandbox-signature'] ?? '';
    const expected = createHmac('sha256', SANDBOX_SECRET).update(rawBody).digest('hex');
    const valid = sig.length > 0 && timingSafeEqualHex(sig, expected);
    const body = safeJson(rawBody);
    return {
      valid,
      eventId: body.eventId ?? '',
      providerRef: body.providerRef ?? '',
      outcome: body.outcome === 'failed' ? 'failed' : 'confirmed',
    };
  },
};

/** Helper used by tests/tools to produce a correctly signed sandbox webhook. */
export function signSandboxWebhook(body: object): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', SANDBOX_SECRET).update(rawBody).digest('hex');
  return { rawBody, signature };
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
