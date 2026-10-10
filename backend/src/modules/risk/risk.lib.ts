// Pure, DB-free risk engine. Callers pass in the facts; this returns a decision.
// Kept testable and provider-agnostic. The service layer gathers the facts (recent
// activity, denylist hits) and enforces the decision before any money moves.

export type RiskDecision = 'allow' | 'review' | 'block';

export interface RiskSignal {
  code: string;
  weight: number;      // contribution to the score
  detail?: string;
}

export interface RiskOutcome {
  decision: RiskDecision;
  score: number;
  signals: RiskSignal[];
}

// Thresholds (a compliance config would own these per market). Score >= block
// hard-stops; >= review routes to a human/hold; below both proceeds.
export const RISK_THRESHOLDS = { review: 40, block: 80 };

export interface RiskInputs {
  amountMinor: bigint;
  currency: string;
  // rolling-window counts/sums for the sender, already measured by the caller
  txnsLastHour: number;
  sumLastHourMinor: bigint;
  distinctRecipientsLastHour: number;
  // screening results the caller computed (never trust a client value)
  senderDenylisted: boolean;
  recipientDenylisted: boolean;
  destinationDenylisted: boolean;   // for cash-out external destination
  newRecipient: boolean;            // first time sender pays this recipient
  // per-tier single-transaction ceiling (from limits), for a "just under" check
  perTxnCeilingMinor: bigint;
}

/**
 * Score a money movement. Deterministic and explainable: every signal that fires
 * is returned with its weight so an analyst (and an audit log) can see *why*.
 */
export function assessRisk(i: RiskInputs): RiskOutcome {
  const signals: RiskSignal[] = [];

  // Hard denylist hits dominate — any one forces a block.
  if (i.senderDenylisted) signals.push({ code: 'sender_denylisted', weight: 100 });
  if (i.recipientDenylisted) signals.push({ code: 'recipient_denylisted', weight: 100 });
  if (i.destinationDenylisted) signals.push({ code: 'destination_denylisted', weight: 100 });

  // Velocity: many transactions in a short window.
  if (i.txnsLastHour >= 20) signals.push({ code: 'high_velocity', weight: 50, detail: `${i.txnsLastHour}/hr` });
  else if (i.txnsLastHour >= 10) signals.push({ code: 'elevated_velocity', weight: 25, detail: `${i.txnsLastHour}/hr` });

  // Fan-out: paying many distinct recipients fast (mule/scatter pattern).
  if (i.distinctRecipientsLastHour >= 10) signals.push({ code: 'high_fanout', weight: 35, detail: `${i.distinctRecipientsLastHour} recipients/hr` });

  // Structuring: repeatedly transacting just under the per-txn ceiling.
  if (i.perTxnCeilingMinor > 0n) {
    const ninetyPct = (i.perTxnCeilingMinor * 90n) / 100n;
    if (i.amountMinor >= ninetyPct && i.amountMinor <= i.perTxnCeilingMinor && i.txnsLastHour >= 3) {
      signals.push({ code: 'possible_structuring', weight: 45, detail: 'repeated near-limit amounts' });
    }
  }

  // Large movement relative to recent behaviour.
  if (i.sumLastHourMinor > 0n && i.amountMinor > i.sumLastHourMinor * 5n) {
    signals.push({ code: 'spike_vs_recent', weight: 20 });
  }

  // A brand-new recipient getting a large amount is mildly elevated.
  if (i.newRecipient && i.amountMinor >= (i.perTxnCeilingMinor * 50n) / 100n) {
    signals.push({ code: 'large_to_new_recipient', weight: 15 });
  }

  const score = signals.reduce((s, x) => s + x.weight, 0);
  let decision: RiskDecision = 'allow';
  if (score >= RISK_THRESHOLDS.block) decision = 'block';
  else if (score >= RISK_THRESHOLDS.review) decision = 'review';

  return { decision, score, signals };
}

// A simple denylist check. In production this is a sanctions/PEP screening
// provider; here it is an exact-match set the service passes in, so the logic is
// deterministic and testable. Normalizes tags/numbers before comparing.
export function isDenylisted(value: string, denylist: Set<string>): boolean {
  if (!value) return false;
  const norm = value.trim().toLowerCase().replace(/\s+/g, '');
  return denylist.has(norm);
}
