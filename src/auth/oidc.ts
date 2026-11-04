import { verifyWithJwks } from 'hono/utils/jwt/jwt';
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws';

/** A provider that hangs mustn't hold sign-ins open. */
const providerDeadline = () => AbortSignal.timeout(10_000);

/** What Budd needs from a provider's discovery document. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  prompt_values_supported?: string[];
}

/** A verified sign-in. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  /** The provider's display name and picture (`name`, `picture`), if it gave them. */
  name: string | undefined;
  picture: string | undefined;
  /** Google Workspace domain (`hd` claim), if any. */
  hostedDomain: string | undefined;
  /** When the person last authenticated at the provider (`auth_time`), in ms, if it said. */
  authTime: number | undefined;
}

/**
 * A picture URL Budd will show: https, of a sane length, on an ordinary host.
 * Its origin goes into the page's CSP, so a host with `;`, `,` or `*` is refused.
 */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9.-]+(:\d+)?$/.test(url.host)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export class OidcError extends Error {
  override name = 'OidcError';
  constructor(
    readonly code:
      'provider_unavailable' | 'invalid_token' | 'email_unverified' | 'domain_not_allowed',
    message: string,
  ) {
    super(message);
  }
}

const SKEW_MS = 60_000;

/** Google's own mail domains: their accounts are Google's, with no Workspace. */
const GOOGLE_MAIL = new Set(['@gmail.com', '@googlemail.com']);

/**
 * Human sign-in through any OpenID Connect provider (Google by default). Uses
 * the authorization code flow with PKCE, state and nonce, and verifies the ID
 * token's signature against the provider's published keys.
 */
export class OidcClient {
  private discovery: Promise<Discovery> | undefined;
  private keys: { keys: HonoJsonWebKey[]; fetchedAt: number } | undefined;
  /** The one Google Workspace domain allowed in, if that's the whole rule: safe to name. */
  readonly soleDomain: string | undefined;

  constructor(
    private readonly opts: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      allowedHd: string[];
      allowedEmails: string[];
      google: boolean;
      clock: () => number;
    },
  ) {
    this.soleDomain =
      opts.allowedHd.length === 1 && opts.allowedEmails.length === 0
        ? opts.allowedHd[0]
        : undefined;
  }

  /**
   * Where the person signs in, as they'll see it. Usually the issuer's host,
   * but not always (Amazon Cognito signs in on another domain).
   */
  async signInHost(): Promise<string> {
    try {
      return new URL((await this.discover()).authorization_endpoint).host;
    } catch {
      return new URL(this.opts.issuer).host;
    }
  }

  /**
   * With `reauthenticate`, asks the provider to make the person sign in again
   * (`max_age=0`) and to report when they did (`auth_time`, also requested as
   * an essential claim, which is how Google provides it). `prompt=login` is
   * added only for providers that list it: Google, for one, doesn't support it.
   * Providers may ignore all of these, so the caller must check `authTime`.
   */
  async authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    reauthenticate?: boolean;
  }): Promise<string> {
    const d = await this.discover();
    const url = new URL(d.authorization_endpoint);
    const prompt = input.reauthenticate
      ? d.prompt_values_supported?.includes('login') && 'login'
      : 'select_account';
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: 'openid email profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(prompt && { prompt }),
      ...(input.reauthenticate && {
        max_age: '0',
        claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
      }),
      // Google: pre-select the allowed domain's accounts (still verified server-side).
      ...(this.soleDomain && { hd: this.soleDomain }),
    }).toString();
    return url.toString();
  }

  /** Exchanges the code and returns the verified identity. */
  async finish(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<OidcIdentity> {
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (methods.includes('client_secret_basic')) {
      const basic = `${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
    } else {
      body.set('client_id', this.opts.clientId);
      body.set('client_secret', this.opts.clientSecret);
    }
    let res: Response;
    try {
      res = await fetch(d.token_endpoint, {
        method: 'POST',
        headers,
        body,
        signal: providerDeadline(),
      });
    } catch {
      throw new OidcError('provider_unavailable', 'Could not reach the sign-in provider.');
    }
    if (!res.ok) {
      throw new OidcError(
        'invalid_token',
        `The sign-in provider refused the code (${String(res.status)}).`,
      );
    }
    const { id_token: idToken } = (await res.json()) as { id_token?: string };
    if (typeof idToken !== 'string') {
      throw new OidcError('invalid_token', 'The sign-in provider returned no ID token.');
    }
    return this.verifyIdToken(idToken, input.nonce);
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<OidcIdentity> {
    const d = await this.discover();
    let claims: Record<string, unknown>;
    try {
      claims = await this.verifySignature(idToken, d, false);
    } catch {
      // The provider may have rotated its keys: refetch once and retry.
      try {
        claims = await this.verifySignature(idToken, d, true);
      } catch {
        throw new OidcError('invalid_token', 'The ID token’s signature or audience is invalid.');
      }
    }
    const now = this.opts.clock();
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
    const iat = typeof claims.iat === 'number' ? claims.iat * 1000 : Infinity;
    if (exp + SKEW_MS <= now || iat - SKEW_MS > now) {
      throw new OidcError('invalid_token', 'The ID token has expired or is not yet valid.');
    }
    if (claims.nonce !== nonce) {
      throw new OidcError('invalid_token', 'The ID token was not issued for this sign-in.');
    }
    if (claims.azp !== undefined && claims.azp !== this.opts.clientId) {
      throw new OidcError('invalid_token', 'The ID token was issued to a different client.');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!email || !verified) {
      throw new OidcError('email_unverified', 'Your account has no verified email address.');
    }
    const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : undefined;
    if (!this.allows(email, hd)) {
      throw new OidcError(
        'domain_not_allowed',
        this.soleDomain
          ? `Only accounts from ${this.soleDomain} can sign in to this Budd.`
          : `${email} can't sign in to this Budd. Ask whoever runs it to add you.`,
      );
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      throw new OidcError('invalid_token', 'The ID token has no subject.');
    }
    return {
      issuer: d.issuer,
      subject: claims.sub,
      email,
      name:
        typeof claims.name === 'string' ? claims.name.trim().slice(0, 100) || undefined : undefined,
      picture: httpsUrl(claims.picture),
      hostedDomain: hd,
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time * 1000 : undefined,
    };
  }

  private allows(email: string, hd: string | undefined): boolean {
    const { allowedHd, allowedEmails, google } = this.opts;
    if (allowedHd.length === 0 && allowedEmails.length === 0) return true;
    const domain = email.slice(email.lastIndexOf('@'));
    // Anyone who once received mail at a domain can make a personal Google
    // account with that address, so with Google an @domain needs its Workspace.
    const domainVouched = !google || GOOGLE_MAIL.has(domain) || hd === domain.slice(1);
    return (
      (hd !== undefined && allowedHd.includes(hd)) ||
      allowedEmails.includes(email) ||
      (allowedEmails.includes(domain) && domainVouched)
    );
  }

  private async verifySignature(
    idToken: string,
    d: Discovery,
    refresh: boolean,
  ): Promise<Record<string, unknown>> {
    if (refresh || !this.keys) {
      const res = await fetch(d.jwks_uri, { signal: providerDeadline() });
      if (!res.ok) throw new Error('jwks unavailable');
      const body = (await res.json()) as { keys?: HonoJsonWebKey[] };
      this.keys = { keys: body.keys ?? [], fetchedAt: this.opts.clock() };
    }
    return await verifyWithJwks(idToken, {
      keys: this.keys.keys,
      allowedAlgorithms: ['RS256', 'ES256'],
      // Time claims are checked against Budd's clock above.
      verification: { iss: d.issuer, aud: this.opts.clientId, exp: false, nbf: false, iat: false },
    });
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const issuer = this.opts.issuer.replace(/\/$/, '');
      let res: Response;
      try {
        res = await fetch(`${issuer}/.well-known/openid-configuration`, {
          signal: providerDeadline(),
        });
      } catch {
        throw new OidcError('provider_unavailable', 'Could not reach the sign-in provider.');
      }
      if (!res.ok)
        throw new OidcError('provider_unavailable', 'Sign-in provider discovery failed.');
      const d = (await res.json()) as Discovery;
      if (d.issuer.replace(/\/$/, '') !== issuer) {
        throw new OidcError(
          'provider_unavailable',
          'The sign-in provider reported a different issuer.',
        );
      }
      return d;
    })().catch((err: unknown) => {
      this.discovery = undefined; // retry next time
      throw err;
    });
    return this.discovery;
  }
}
