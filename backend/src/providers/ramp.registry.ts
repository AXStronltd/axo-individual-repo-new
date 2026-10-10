import { env } from '../config/env.js';
import type { RampProvider, RampOp } from './ramp.js';
import { supports } from './ramp.js';
import { SandboxRampProvider } from './ramp.sandbox.js';
import { MpesaRampProvider } from './ramp.mpesa.js';
import { CryptoRampProvider } from './ramp.crypto.js';

// The set of ramp adapters this deployment knows about. In sandbox the sandbox
// ramp is the one that is available; in live, real adapters (M-Pesa, bank, agent)
// become available as their credentials are configured.
export function allRamps(): RampProvider[] {
  const list: RampProvider[] = [new MpesaRampProvider(), new CryptoRampProvider()];
  if (env.APP_ENV !== 'live') list.push(new SandboxRampProvider(env.RAMP_SANDBOX_SECRET));
  return list;
}

/**
 * Pick the best available ramp for an op/country/currency, or null if none is
 * configured — in which case the feature is genuinely unavailable and the caller
 * must say so, not simulate success. An explicit provider name can be requested.
 */
export function pickRamp(op: RampOp, country: string, currency: string, name?: string): RampProvider | null {
  const ramps = allRamps();
  if (name) {
    const chosen = ramps.find((r) => r.name === name);
    return chosen && supports(chosen, op, country, currency) ? chosen : null;
  }
  return ramps.find((r) => supports(r, op, country, currency)) ?? null;
}

/** For the admin "provider connection status" view (§13). */
export function rampStatus() {
  return allRamps().map((r) => ({
    name: r.name,
    available: r.available,
    ops: r.ops,
    countries: r.countries,
    currencies: r.currencies,
  }));
}
