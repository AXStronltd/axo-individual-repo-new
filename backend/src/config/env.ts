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
};

export const env = schema.parse(raw);
export const isLive = env.APP_ENV === 'live';
