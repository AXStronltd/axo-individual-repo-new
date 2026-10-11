import { z } from 'zod';

const schema = z.object({
  APP_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ARGON2_PEPPER: z.string().default(''),
  // WhatsApp Cloud API (Phase 6). Optional: when unset, outbound messaging is
  // reported unavailable and the webhook still verifies inbound events.
  WHATSAPP_VERIFY_TOKEN: z.string().default('dev-verify-token'),
  WHATSAPP_APP_SECRET: z.string().default('dev-app-secret'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  // Cash-in/out ramps (Phase 7). Optional: unset ⇒ that ramp is unavailable and
  // the service refuses to use it (never a faked transfer).
  RAMP_SANDBOX_SECRET: z.string().default('sandbox-ramp-secret'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_WEBHOOK_SECRET: z.string().optional(),
  // Crypto receive/send ramp (Phase 9). Unset ⇒ unavailable.
  CRYPTO_WEBHOOK_SECRET: z.string().optional(),
  CRYPTO_API_KEY: z.string().optional(),
  // Signs sandbox charge webhooks. Sandbox only — the sandbox charge provider is
  // not registered in live.
  SANDBOX_WEBHOOK_SECRET: z.string().default('sandbox-webhook-secret'),
  // Platform-operator credential (X-Ops-Key header) for actions no merchant may
  // take: creating agents and funding agent float. Unset ⇒ those routes refuse.
  OPS_API_KEY: z.string().optional(),
  // Bank collection (Phase 16). The collection bank signs its deposit webhooks
  // with this; unset ⇒ the automated webhook refuses (503) and only an operator
  // can confirm deposits.
  BANK_WEBHOOK_SECRET: z.string().optional(),
  // The real collection accounts customers transfer to, as JSON keyed by bank
  // code (see bank.lib.ts). Unset ⇒ live refuses bank top-ups; sandbox offers a
  // clearly-labelled sandbox account. Account details are never invented.
  BANK_COLLECTION_ACCOUNTS: z.string().optional(),
});

// Allow tests to run without a full .env by supplying safe defaults.
const raw = {
  APP_ENV: process.env.APP_ENV ?? 'sandbox',
  PORT: process.env.PORT ?? '4000',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://axo:axo@localhost:5432/axo_business?schema=public',
  REDIS_URL: process.env.REDIS_URL,
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-access-secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
  ARGON2_PEPPER: process.env.ARGON2_PEPPER ?? '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN ?? 'dev-verify-token',
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET ?? 'dev-app-secret',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  RAMP_SANDBOX_SECRET: process.env.RAMP_SANDBOX_SECRET ?? 'sandbox-ramp-secret',
  MPESA_CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE: process.env.MPESA_SHORTCODE,
  MPESA_WEBHOOK_SECRET: process.env.MPESA_WEBHOOK_SECRET,
  CRYPTO_WEBHOOK_SECRET: process.env.CRYPTO_WEBHOOK_SECRET,
  CRYPTO_API_KEY: process.env.CRYPTO_API_KEY,
  SANDBOX_WEBHOOK_SECRET: process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-webhook-secret',
  OPS_API_KEY: process.env.OPS_API_KEY,
  BANK_WEBHOOK_SECRET: process.env.BANK_WEBHOOK_SECRET,
  BANK_COLLECTION_ACCOUNTS: process.env.BANK_COLLECTION_ACCOUNTS,
};

// Public placeholder values that ship in code or in .env.example. Any of these in
// a live deployment means the secret is known to everyone who has read the repo.
const KNOWN_DEFAULTS = new Set([
  'dev-access-secret', 'dev-refresh-secret', 'dev-verify-token', 'dev-app-secret',
  'change-me-access-secret', 'change-me-refresh-secret', 'change-me-pepper',
  'change-me-verify-token', 'change-me-app-secret',
]);

/**
 * Problems that make a config unsafe to run with real money. Empty in sandbox.
 * The defaults above exist so tests and local dev run without a .env; in live,
 * falling back to any of them would let anyone forge staff or customer tokens
 * and WhatsApp webhooks, so the process must refuse to start instead.
 */
export function liveConfigProblems(e: z.infer<typeof schema>): string[] {
  if (e.APP_ENV !== 'live') return [];
  const problems: string[] = [];
  const secrets: Array<[string, string]> = [
    ['JWT_SECRET', e.JWT_SECRET],
    ['JWT_REFRESH_SECRET', e.JWT_REFRESH_SECRET],
    ['ARGON2_PEPPER', e.ARGON2_PEPPER],
    ['WHATSAPP_VERIFY_TOKEN', e.WHATSAPP_VERIFY_TOKEN],
    ['WHATSAPP_APP_SECRET', e.WHATSAPP_APP_SECRET],
  ];
  for (const [name, value] of secrets) {
    if (!value || KNOWN_DEFAULTS.has(value)) problems.push(`${name} is unset or a public default`);
    else if (value.length < 32 && name.startsWith('JWT')) problems.push(`${name} must be at least 32 characters`);
  }
  if (e.JWT_SECRET === e.JWT_REFRESH_SECRET) problems.push('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  // Optional, but a short shared secret would let anyone forge bank deposits.
  if (e.BANK_WEBHOOK_SECRET !== undefined && e.BANK_WEBHOOK_SECRET.length < 32) problems.push('BANK_WEBHOOK_SECRET must be at least 32 characters');
  return problems;
}

export const env = schema.parse(raw);

const problems = liveConfigProblems(env);
if (problems.length) {
  throw new Error('Refusing to start in live mode with unsafe configuration:\n- ' + problems.join('\n- '));
}
export const isLive = env.APP_ENV === 'live';
