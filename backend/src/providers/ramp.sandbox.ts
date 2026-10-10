import crypto from 'node:crypto';
import type {
  RampProvider,
  CashInRequest,
  CashOutRequest,
  RampResult,
  RampWebhook,
  RampOp,
} from './ramp.js';

// A fully in-memory ramp for dev/tests. Runs the real request → accepted →
// webhook → confirmed path with no external money, and signs its own webhooks so
// the signature-verification code path is exercised end to end.
export class SandboxRampProvider implements RampProvider {
  readonly name = 'ramp-sandbox';
  readonly available = true;
  readonly ops: RampOp[] = ['cash_in', 'cash_out'];
  readonly countries = ['KE', 'SO', 'US'];
  readonly currencies = ['KES', 'USD'];

  constructor(private secret = 'sandbox-ramp-secret') {}

  async cashIn(req: CashInRequest): Promise<RampResult> {
    if (req.amountMinor <= 0n) return { providerRef: '', status: 'rejected', reason: 'bad_amount' };
    return { providerRef: 'rin_' + req.reference, status: 'accepted' };
  }

  async cashOut(req: CashOutRequest): Promise<RampResult> {
    if (req.amountMinor <= 0n) return { providerRef: '', status: 'rejected', reason: 'bad_amount' };
    return { providerRef: 'rout_' + req.reference, status: 'accepted' };
  }

  /** Build a correctly-signed webhook body for tests/demos. */
  signWebhook(body: object): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
    return { headers: { 'x-ramp-signature': sig }, rawBody };
  }

  parseWebhook(headers: Record<string, string>, rawBody: string): RampWebhook {
    const header = headers['x-ramp-signature'];
    const expected = 'sha256=' + crypto.createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
    let valid = false;
    if (header && header.length === expected.length) {
      valid = crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    }
    let parsed: any = {};
    try { parsed = JSON.parse(rawBody); } catch { valid = false; }
    return {
      valid,
      eventId: parsed.eventId ?? '',
      providerRef: parsed.providerRef ?? '',
      op: (parsed.op as RampOp) ?? 'cash_in',
      outcome: parsed.outcome === 'failed' ? 'failed' : 'confirmed',
    };
  }
}
