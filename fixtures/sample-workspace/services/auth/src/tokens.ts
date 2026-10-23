// Session tokens: random, opaque, and checked in constant time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Token {
  /** What the client holds. */
  value: string;
  /** What the server stores: never the token itself. */
  digest: string;
  expiresAt: number;
}

const TOKEN_BYTES = 32;
const LIFETIME_MS = 30 * 60 * 1000;

export function issueToken(now = Date.now()): Token {
  const value = randomBytes(TOKEN_BYTES).toString('base64url');
  return { value, digest: digestOf(value), expiresAt: now + LIFETIME_MS };
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function checkToken(presented: string, stored: Token, now = Date.now()): boolean {
  if (now >= stored.expiresAt) return false;
  const a = Buffer.from(digestOf(presented), 'hex');
  const b = Buffer.from(stored.digest, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
