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

// A crypto ramp: a business RECEIVES stablecoin (USDC/USDT) into its Axo balance,
// and can SEND stablecoin out (global payout). Settlement confirms by webhook,
// exactly like the fiat ramps — the Axo balance only moves on confirmation.
// Unavailable without a configured custody/settlement provider, so it never fakes
// a crypto transfer. Custody/compliance is a licensed function; this is the rail
// adapter, not permission to hold crypto for third parties.
export class CryptoRampProvider implements RampProvider {
  readonly name = 'crypto';
  readonly ops: RampOp[] = ['cash_in', 'cash_out'];
  readonly countries: string[] = []; // [] = global
  readonly currencies = ['USDC', 'USDT', 'USD'];

  constructor(private secret = env.CRYPTO_WEBHOOK_SECRET ?? '') {}

  get available(): boolean {
    return Boolean(env.CRYPTO_API_KEY && env.CRYPTO_WEBHOOK_SECRET);
  }

  async cashIn(req: CashInRequest): Promise<RampResult> {
    if (!this.available) return { providerRef: '', status: 'rejected', reason: 'crypto_not_configured' };
    // Real impl: create a deposit intent / address, return its id as providerRef;
    // the chain-watcher confirms by webhook when the stablecoin arrives.
    if (req.amountMinor <= 0n) return { providerRef: '', status: 'rejected', reason: 'bad_amount' };
    return { providerRef: 'cin_' + req.reference, status: 'accepted' };
  }

  async cashOut(req: CashOutRequest): Promise<RampResult> {
    if (!this.available) return { providerRef: '', status: 'rejected', reason: 'crypto_not_configured' };
    // Real impl: submit an on-chain transfer to req.destination (a wallet address);
    // confirmed by webhook when the tx is mined to the required depth.
    if (req.amountMinor <= 0n) return { providerRef: '', status: 'rejected', reason: 'bad_amount' };
    return { providerRef: 'cout_' + req.reference, status: 'accepted' };
  }

  parseWebhook(headers: Record<string, string>, rawBody: string): RampWebhook {
    const header = headers['x-crypto-signature'];
    let valid = false;
    if (this.secret && header) {
      const expected = 'sha256=' + crypto.createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
      valid = header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    }
    let parsed: any = {};
    try { parsed = JSON.parse(rawBody); } catch { valid = false; }
    return {
      valid,
      eventId: parsed.eventId ?? parsed.txHash ?? '',
      providerRef: parsed.providerRef ?? '',
      op: (parsed.op as RampOp) ?? 'cash_in',
      outcome: parsed.outcome === 'failed' ? 'failed' : 'confirmed',
    };
  }
}
