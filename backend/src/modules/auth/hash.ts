import argon2 from 'argon2';
import { env } from '../../config/env.js';

// argon2id with a server-side pepper. Secrets are never stored in plaintext.
const opts = { type: argon2.argon2id } as const;

export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret + env.ARGON2_PEPPER, opts);
}

export function verifySecret(hash: string, secret: string): Promise<boolean> {
  return argon2.verify(hash, secret + env.ARGON2_PEPPER);
}
