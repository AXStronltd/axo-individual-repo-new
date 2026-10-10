// Pure FX helpers for cross-border ("send globally"). Rates are injected by the
// caller (a real build pulls them from a provider); the math is integer-safe and
// testable. A spread is applied and disclosed, never hidden.

export interface FxQuote {
  fromCurrency: string;
  toCurrency: string;
  sendMinor: bigint;        // debited from the sender (source currency)
  rate: number;             // mid-market units of TO per 1 FROM
  spreadBps: number;        // basis points added as the fee
  receiveMinor: bigint;     // what the recipient gets (dest currency)
  feeMinor: bigint;         // the spread, expressed in source minor units
}

/**
 * Quote a cross-border transfer. `rate` is destination units per source unit at
 * mid-market; the spread is taken off the rate the customer receives, and the
 * equivalent fee in source units is disclosed. Decimals default to 2 but are
 * caller-supplied for zero-decimal currencies.
 */
export function quoteFx(params: {
  sendMinor: bigint;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  spreadBps?: number;       // default 100bps (1%)
  fromDecimals?: number;
  toDecimals?: number;
}): FxQuote {
  if (params.sendMinor <= 0n) throw new Error('amount must be positive');
  if (!(params.rate > 0)) throw new Error('rate must be positive');
  const spreadBps = params.spreadBps ?? 100;
  const fromDec = params.fromDecimals ?? 2;
  const toDec = params.toDecimals ?? 2;

  // effective rate after spread
  const effRate = params.rate * (1 - spreadBps / 10_000);

  // Convert using a scaled integer rate to avoid float drift on the minor units.
  // sendMajor = sendMinor / 10^fromDec ; receiveMajor = sendMajor * effRate
  // receiveMinor = round(receiveMajor * 10^toDec)
  const RATE_SCALE = 1_000_000n;
  const effScaled = BigInt(Math.round(effRate * Number(RATE_SCALE)));
  const pow = (n: number) => 10n ** BigInt(n);
  const receiveMinor = (params.sendMinor * effScaled * pow(toDec)) / (RATE_SCALE * pow(fromDec));

  // fee in source minor units = sendMinor * spreadBps / 10000
  const feeMinor = (params.sendMinor * BigInt(spreadBps)) / 10_000n;

  return {
    fromCurrency: params.fromCurrency,
    toCurrency: params.toCurrency,
    sendMinor: params.sendMinor,
    rate: params.rate,
    spreadBps,
    receiveMinor,
    feeMinor,
  };
}
