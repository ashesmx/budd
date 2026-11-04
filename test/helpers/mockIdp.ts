import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as rsaSign,
  type KeyObject,
} from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

export interface IdpUser {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  picture?: string;
}

/** Ways the mock IdP can misbehave, to prove Budd rejects each. */
export type Tamper =
  | 'bad-signature'
  | 'wrong-audience'
  | 'wrong-issuer'
  | 'expired'
  | 'wrong-nonce'
  /** Signs the person in without asking: auth_time is an hour old. */
  | 'stale-auth-time'
  | 'no-auth-time';

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next sign-in is (the IdP auto-approves). */
  user: IdpUser;
  tamper: Tamper | undefined;
  /** Like Google: reports auth_time only when asked through `claims`, never for `max_age`. */
  authTimeOnlyViaClaims: boolean;
  /** Advertised as prompt_values_supported in discovery, if set. */
  promptValues: string[] | undefined;
  /** The query of the last authorization request. */
  lastAuthorize: Record<string, string> | undefined;
  close(): Promise<void>;
}

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

function signJwt(payload: object, key: KeyObject, kid: string): string {
  const data = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url(payload)}`;
  return `${data}.${rsaSign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

/**
 * A minimal OpenID Connect provider for tests: discovery, JWKS, an
 * authorization endpoint that signs in `idp.user` at once, and a token
 * endpoint that checks the client secret and PKCE and returns a signed ID token.
 */
export async function startMockIdp(clock: { now: number }): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { user: IdpUser; nonce: string; challenge: string; redirectUri: string; authTime: boolean }
  >();
  const app = new Hono();
  let issuer = '';

  const idp: MockIdp = {
    issuer: '',
    clientId: 'budd-test-client',
    clientSecret: 'budd-test-secret',
    user: { sub: 'alice-sub', email: 'alice@example.com', email_verified: true },
    tamper: undefined,
    authTimeOnlyViaClaims: false,
    promptValues: undefined,
    lastAuthorize: undefined,
    close: () => Promise.resolve(),
  };

  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      id_token_signing_alg_values_supported: ['RS256'],
      ...(idp.promptValues && { prompt_values_supported: idp.promptValues }),
    }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk] }));

  app.get('/authorize', (c) => {
    const q = c.req.query();
    idp.lastAuthorize = q;
    if (q.client_id !== idp.clientId || q.code_challenge_method !== 'S256') {
      return c.text('bad request', 400);
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      user: { ...idp.user },
      nonce: q.nonce ?? '',
      challenge: q.code_challenge ?? '',
      redirectUri: q.redirect_uri ?? '',
      // auth_time is reported when asked for (OIDC Core §2, §5.5).
      authTime:
        (q.claims ?? '').includes('auth_time') ||
        (q.max_age !== undefined && !idp.authTimeOnlyViaClaims),
    });
    const back = new URL(q.redirect_uri ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.state ?? '');
    return c.redirect(back.toString(), 302);
  });

  app.post('/token', async (c) => {
    const expected = `Basic ${Buffer.from(`${idp.clientId}:${idp.clientSecret}`).toString('base64')}`;
    if (c.req.header('authorization') !== expected) return c.json({ error: 'invalid_client' }, 401);
    const form = await c.req.parseBody();
    const code = typeof form.code === 'string' ? form.code : '';
    const entry = codes.get(code);
    codes.delete(code);
    const verifier = typeof form.code_verifier === 'string' ? form.code_verifier : '';
    if (
      !entry ||
      entry.redirectUri !== form.redirect_uri ||
      createHash('sha256').update(verifier).digest('base64url') !== entry.challenge
    ) {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const now = Math.floor(clock.now / 1000);
    const t = idp.tamper;
    const claims = {
      iss: t === 'wrong-issuer' ? 'https://evil.example' : issuer,
      aud: t === 'wrong-audience' ? 'someone-else' : idp.clientId,
      sub: entry.user.sub,
      email: entry.user.email,
      email_verified: entry.user.email_verified ?? true,
      ...(entry.user.hd !== undefined && { hd: entry.user.hd }),
      ...(entry.user.name !== undefined && { name: entry.user.name }),
      ...(entry.user.picture !== undefined && { picture: entry.user.picture }),
      nonce: t === 'wrong-nonce' ? 'not-the-nonce' : entry.nonce,
      iat: t === 'expired' ? now - 7200 : now,
      exp: t === 'expired' ? now - 3600 : now + 3600,
      ...(entry.authTime &&
        t !== 'no-auth-time' && { auth_time: t === 'stale-auth-time' ? now - 3600 : now }),
    };
    return c.json({
      id_token: signJwt(claims, t === 'bad-signature' ? other : privateKey, kid),
      access_token: 'idp-access-token',
      token_type: 'Bearer',
    });
  });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => {
      resolve(s);
    });
  });
  const address = server.address();
  issuer = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  idp.issuer = issuer;
  idp.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return idp;
}
