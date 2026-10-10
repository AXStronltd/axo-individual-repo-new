import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type {
  RampProvider,
  CashInRequest,
  CashOutRequest,
  RampResult,
  RampWebhook,
  RampOp,
} from './ramp.js';

// An M-Pesa-style on/off-ramp adapter (Kenya). This is the TEMPLATE a real
// Daraja integration drops into: C2B/STK push for cash-in, B2C for cash-out,
// confirmation via Safaricom's result callback. It is deliberately NOT wired to
// live endpoints here — without credentials it reports `available: false`, so the
// service refuses to use it rather than pretend money moved. A technical
// integration is not regulatory permission: this must run through the licensed
// entity and an authorized Safaricom agreement.
export class MpesaRampProvider implements RampProvider {
  readonly name = 'mpesa';
  readonly ops: RampOp[] = ['cash_in', 'cash_out'];
  readonly countries = ['KE'];
  readonly currencies = ['KES'];

  get available(): boolean {
    return Boolean(env.MPESA_CONSUMER_KEY && env.MPESA_CONSUMER_SECRET && env.MPESA_SHORTCODE && env.MPESA_WEBHOOK_SECRET);
  }

  async cashIn(_req: CashInRequest): Promise<RampResult> {
    if (!this.available) return { providerRef: '', status: 'rejected', reason: 'mpesa_not_configured' };
    // Real implementation: OAuth token -> STK push / C2B register; returns a
    // CheckoutRequestID we store as providerRef; money confirmed by callback.
    throw new Error('mpesa cashIn not implemented — supply Daraja credentials and wire STK push');
  }

  async cashOut(_req: CashOutRequest): Promise<RampResult> {
    if (!this.available) return { providerRef: '', status: 'rejected', reason: 'mpesa_not_configured' };
    // Real implementation: B2C payment request; confirmed by the result callback.
    throw new Error('mpesa cashOut not implemented — supply Daraja credentials and wire B2C');
  }

  parseWebhook(headers: Record<string, string>, rawBody: string): RampWebhook {
    // Safaricom callbacks are not HMAC-signed by default; production deployments
    // put them behind an allow-listed callback URL + a shared secret header. We
    // model that shared-secret check here so the verification path is explicit.
    const secret = env.MPESA_WEBHOOK_SECRET ?? '';
    const header = headers['x-mpesa-signature'];
    let valid = false;
    if (secret && header) {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
      valid = header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    }
    let parsed: any = {};
    try { parsed = JSON.parse(rawBody); } catch { valid = false; }
    return {
      valid,
      eventId: parsed.eventId ?? parsed.CheckoutRequestID ?? '',
      providerRef: parsed.providerRef ?? parsed.CheckoutRequestID ?? '',
      op: (parsed.op as RampOp) ?? 'cash_in',
      outcome: parsed.outcome === 'failed' || parsed.ResultCode ? 'failed' : 'confirmed',
    };
  }
}
