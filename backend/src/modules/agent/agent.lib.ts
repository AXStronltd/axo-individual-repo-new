// Pure, DB-free agent helpers — testable without a database.

/** Commission an agent earns on a cash-in/out, in minor units. */
export function agentCommission(amountMinor: bigint, commissionBps: number): bigint {
  if (amountMinor <= 0n || commissionBps <= 0) return 0n;
  return (amountMinor * BigInt(commissionBps)) / 10_000n;
}

export type FloatCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Can the agent perform this operation given its float?
 *  - cash_in: the agent gives Axo value to the customer, so its float must cover
 *    the amount (float goes DOWN).
 *  - cash_out: the agent receives Axo value and pays out cash, so float goes UP;
 *    no float ceiling needed (a cap could be added for AML).
 */
export function checkAgentFloat(params: {
  kind: 'cash_in' | 'cash_out';
  amountMinor: bigint;
  floatMinor: bigint;
  status: string;
}): FloatCheck {
  if (params.status !== 'active') return { ok: false, reason: 'agent is not active' };
  if (params.amountMinor <= 0n) return { ok: false, reason: 'amount must be positive' };
  if (params.kind === 'cash_in' && params.amountMinor > params.floatMinor) {
    return { ok: false, reason: 'agent has insufficient float' };
  }
  return { ok: true };
}
