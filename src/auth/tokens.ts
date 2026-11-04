import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque, random bearer credentials. The prefix makes leaked tokens easy to recognise. */
export const newToken = (prefix: 'budd_at' | 'budd_rt' | 'budd_code' | 'budd_cs' | 'budd_key') =>
  `${prefix}_${randomBytes(32).toString('base64url')}`;

/** API keys (ADR 0016): `budd_key_` and 43 base64url characters, easy for secret scanners to match. */
export const KEY_PREFIX = 'budd_key';

/** How codes, tokens and client secrets are stored and looked up. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Session ids, CSRF tokens, OIDC state and nonces. */
export const randomToken = () => randomBytes(32).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) must equal the challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return (
    /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) && safeEqual(pkceChallenge(verifier), challenge)
  );
}
