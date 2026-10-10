// Cash-in / cash-out "ramp" adapters: the ON-RAMP and OFF-RAMP that bridge
// external money (M-Pesa, EVC, a bank, an agent) into and out of an Axo wallet.
//
// Design rules (brief §7, §12):
//  - Each adapter declares which operations, countries and currencies it supports.
//  - If an adapter's credentials are not configured it is UNAVAILABLE — the
//    service refuses the request rather than faking a successful transfer.
//  - A request is only ever "accepted" (the external side took it). Money is not
//    confirmed until a verified webhook arrives. We never treat accepted as paid.
//  - We do NOT assume access to M-Pesa/EVC/banks: only the sandbox is wired.
//    Real adapters drop in behind this same interface with real credentials.

export type RampOp = 'cash_in' | 'cash_out';

export interface RampCapabilities {
  readonly name: string;
  readonly available: boolean;            // credentials present?
  readonly ops: RampOp[];                 // which directions it supports
  readonly countries: string[];           // ISO-3166 alpha-2
  readonly currencies: string[];          // ISO-4217
}

export interface CashInRequest {
  amountMinor: bigint;
  currency: string;
  // the external source the customer funds FROM (e.g. an M-Pesa number). This is
  // where the external provider pulls/collects the money.
  source: string;
  reference: string;                      // our transaction/transfer id
}

export interface CashOutRequest {
  amountMinor: bigint;
  currency: string;
  // the external destination the customer withdraws TO (M-Pesa number, bank acct…)
  destination: string;
  reference: string;
}

export interface RampResult {
  providerRef: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

export interface RampWebhook {
  valid: boolean;
  eventId: string;
  providerRef: string;
  op: RampOp;
  outcome: 'confirmed' | 'failed';
}

export interface RampProvider extends RampCapabilities {
  cashIn(req: CashInRequest): Promise<RampResult>;
  cashOut(req: CashOutRequest): Promise<RampResult>;
  parseWebhook(headers: Record<string, string>, rawBody: string): RampWebhook;
}

/** Does this provider support the op for the given country+currency? */
export function supports(p: RampCapabilities, op: RampOp, country: string, currency: string): boolean {
  return (
    p.available &&
    p.ops.includes(op) &&
    (p.countries.length === 0 || p.countries.includes(country)) &&
    p.currencies.includes(currency)
  );
}
