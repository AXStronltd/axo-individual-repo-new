// Every payment rail implements this interface. The core never knows which
// provider it is talking to. Sandbox vs live is chosen by APP_ENV, not by code path.

export interface ChargeRequest {
  amountMinor: bigint;
  currency: string;
  customerRef: string;
  reference: string; // our transaction id
}

export interface ChargeResult {
  providerRef: string;
  // 'accepted' means the provider took the request; the money is NOT confirmed
  // yet. Confirmation arrives via webhook. We never treat accepted as paid.
  status: 'accepted' | 'rejected';
}

export interface WebhookVerification {
  valid: boolean;
  eventId: string;
  providerRef: string;
  outcome: 'confirmed' | 'failed';
}

export interface PayoutRequest {
  amountMinor: bigint;
  currency: string;
  destination: string; // bank ref / account token
  reference: string;   // our transaction id
}

export interface PayoutResult {
  providerRef: string;
  status: 'accepted' | 'rejected';
}

export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  createPayout(req: PayoutRequest): Promise<PayoutResult>;
  // Verify signature + parse an inbound webhook into a normalized result.
  parseWebhook(headers: Record<string, string>, rawBody: string): WebhookVerification;
}
