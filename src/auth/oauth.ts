import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { ulid } from 'ulid';
import { isLoopbackHost, type Config } from '../config.js';
import type { ClientAuthMethod, OAuthClient, OAuthGrant, TokenPair } from '../domain/auth.js';
import { slugify } from '../domain/slug.js';
import { clip, log, throttledLog } from '../log.js';
import { GatewayError, type WorkspaceGateway } from '../storage/gateway.js';
import type { AuthStore } from '../storage/Storage.js';
import { hashToken, newToken, safeEqual, verifyPkce } from './tokens.js';

const ACCESS_TOKEN_TTL_MS = 60 * 60_000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
export const CODE_TTL_MS = 5 * 60_000;

export interface OAuthDeps {
  config: Config;
  auth: AuthStore;
  gateway: WorkspaceGateway;
  clock: () => number;
}

/** The OAuth endpoints apps call directly (JSON responses, CORS). */
export const OAUTH_API_PATHS = ['/register', '/token', '/revoke'];

/** Where Budd's endpoints live, from PUBLIC_URL. */
export function endpoints(publicUrl: string) {
  return {
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    resourceMetadata: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
    authorize: `${publicUrl}/authorize`,
    token: `${publicUrl}/token`,
    register: `${publicUrl}/register`,
    revoke: `${publicUrl}/revoke`,
  };
}

/** True if `resource` (RFC 8707) names Budd's MCP endpoint. */
export function isOurResource(resource: string, publicUrl: string): boolean {
  const r = resource.replace(/\/$/, '');
  return r === `${publicUrl}/mcp` || r === publicUrl;
}

/** Registration is unauthenticated, so what one registration may store is capped. */
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;

/** Host (or scheme, for app-specific schemes) of a redirect URI, as shown and logged. */
export function redirectHost(raw: string | URL): string {
  const url = new URL(raw);
  return ['http:', 'https:'].includes(url.protocol) ? url.host : url.protocol;
}

/**
 * Whether two redirect URIs return to the same app: the same host (any port
 * on loopback, where native apps pick a new one each time, RFC 8252), or the
 * same private-use scheme.
 */
export function sameRedirectTarget(a: string, b: string): boolean {
  const target = (raw: string) => {
    const url = new URL(raw);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
      ? 'loopback'
      : redirectHost(url);
  };
  return target(a) === target(b);
}

const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

/**
 * Redirect URIs Budd accepts at registration: https anywhere, http only on
 * loopback (native apps, RFC 8252), and private-use schemes such as
 * `cursor://` — never a fragment, and never a scheme that can run code.
 */
function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/**
 * Whether `requested` matches one of a client's registered redirect URIs.
 * Exact match, except that for http loopback redirects the port may differ:
 * native apps pick a free port each time (RFC 8252 §7.3).
 */
export function redirectUriAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== 'http:' || !isLoopbackHost(want.hostname)) return false;
  return registered.some((r) => {
    const have = new URL(r);
    return (
      have.protocol === 'http:' &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search &&
      have.username === want.username &&
      have.password === want.password
    );
  });
}

/** CORS for the endpoints browser-based MCP clients call directly. Bearer tokens only, no cookies. */
export const oauthCors: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
      'Access-Control-Max-Age': '86400',
    });
  }
  await next();
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Expose-Headers', 'www-authenticate, mcp-session-id');
};

export function sendOAuthError(
  c: Context,
  status: 400 | 401 | 429,
  error: string,
  description: string,
): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

/** Mounts the OAuth 2.1 authorization server's machine-facing endpoints (§5). */
export function mountOAuth(app: Hono, deps: OAuthDeps): void {
  const { config, auth, gateway, clock } = deps;
  const logRefusal = throttledLog(60, clock);
  const publicUrl = config.hosted?.publicUrl ?? '';
  const ep = endpoints(publicUrl);

  for (const path of ['/.well-known/*', ...OAUTH_API_PATHS]) app.use(path, oauthCors);

  // RFC 9728: protected resource metadata. Served for the resource path and the root.
  const resourceMetadata = (c: Context) =>
    c.json({
      resource: ep.resource,
      authorization_servers: [ep.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Budd',
    });
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  // RFC 8414: authorization server metadata.
  const methods: ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: ep.issuer,
      authorization_endpoint: ep.authorize,
      token_endpoint: ep.token,
      registration_endpoint: ep.register,
      revocation_endpoint: ep.revoke,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: methods,
      revocation_endpoint_auth_methods_supported: methods,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  // RFC 7591: Dynamic Client Registration.
  app.post('/register', async (c) => {
    const refuse = (error: string, description: string): Response => {
      logRefusal('warn', 'client registration refused', { error, description });
      return sendOAuthError(c, 400, error, description);
    };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return refuse('invalid_client_metadata', 'Send the client metadata as JSON.');
    }
    const parsed = OAuthClientMetadataSchema.safeParse(body);
    if (!parsed.success) {
      return refuse('invalid_client_metadata', parsed.error.issues[0]?.message ?? '');
    }
    const meta = parsed.data;
    const redirectUris = meta.redirect_uris.map(String);
    if (
      redirectUris.length > MAX_REDIRECT_URIS ||
      redirectUris.some((u) => u.length > MAX_REDIRECT_URI_LENGTH)
    ) {
      return refuse(
        'invalid_redirect_uri',
        `Register at most ${String(MAX_REDIRECT_URIS)} redirect URIs of up to ${String(MAX_REDIRECT_URI_LENGTH)} characters.`,
      );
    }
    if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
      return refuse(
        'invalid_redirect_uri',
        'Redirect URIs must be https, http on localhost, or an app-specific scheme, without a fragment.',
      );
    }
    const grantTypes = meta.grant_types ?? ['authorization_code', 'refresh_token'];
    if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      return refuse(
        'invalid_client_metadata',
        'Only authorization_code and refresh_token grants are supported.',
      );
    }
    if ((meta.response_types ?? ['code']).some((r) => r !== 'code')) {
      return refuse('invalid_client_metadata', 'Only the "code" response type is supported.');
    }
    // RFC 7591's default is client_secret_basic; most MCP clients ask for "none".
    const authMethod = (meta.token_endpoint_auth_method ??
      'client_secret_basic') as ClientAuthMethod;
    if (!methods.includes(authMethod)) {
      return refuse(
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of ${methods.join(', ')}.`,
      );
    }
    const now = clock();
    const clientId = `budd_client_${ulid(now).toLowerCase()}`;
    const secret = authMethod === 'none' ? undefined : newToken('budd_cs');
    const clientName = meta.client_name?.trim().slice(0, 100) || null;
    // Registration is open to anyone, so only the fields Budd uses are kept and
    // echoed back; everything else in the request (jwks, software_statement,
    // contacts…) is dropped rather than stored (RFC 7591 §3.2.1 allows this).
    const response = {
      ...(clientName !== null && { client_name: clientName }),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret !== undefined && { client_secret: secret, client_secret_expires_at: 0 }),
    };
    // Stored metadata is the registration response without the secret.
    const stored = Object.fromEntries(
      Object.entries(response).filter(([k]) => k !== 'client_secret'),
    );
    const client: OAuthClient = {
      clientId,
      clientSecretHash: secret === undefined ? null : hashToken(secret),
      authMethod,
      clientName,
      slugBase: slugify(clientName ?? 'client', 'client'),
      redirectUris,
      metadata: stored,
      createdAt: now,
    };
    await auth.createClient(client);
    log.info('client registered', {
      client_id: clientId,
      client_name: clientName,
      redirect_hosts: [...new Set(redirectUris.map(redirectHost))],
    });
    c.header('Cache-Control', 'no-store');
    return c.json(response, 201);
  });

  /** Client authentication at the token and revocation endpoints. */
  const authenticateClient = async (
    c: Context,
    form: Record<string, unknown>,
  ): Promise<OAuthClient | undefined> => {
    let clientId = typeof form.client_id === 'string' ? form.client_id : undefined;
    let secret = typeof form.client_secret === 'string' ? form.client_secret : undefined;
    const header = c.req.header('authorization');
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const i = decoded.indexOf(':');
      if (i > 0) {
        try {
          clientId = decodeURIComponent(decoded.slice(0, i));
          secret = decodeURIComponent(decoded.slice(i + 1));
        } catch {
          return undefined; // malformed percent-encoding: not a valid client
        }
      }
    }
    if (clientId === undefined) return undefined;
    const client = await auth.getClient(clientId);
    if (!client) return undefined;
    if (client.clientSecretHash === null) return client; // public client: PKCE protects it
    return secret !== undefined && safeEqual(hashToken(secret), client.clientSecretHash)
      ? client
      : undefined;
  };

  const newPair = (now: number): { tokens: TokenPair; access: string; refresh: string } => {
    const access = newToken('budd_at');
    const refresh = newToken('budd_rt');
    return {
      access,
      refresh,
      tokens: {
        accessHash: hashToken(access),
        refreshHash: hashToken(refresh),
        accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
        refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      },
    };
  };

  const tokenResponse = (c: Context, pair: { access: string; refresh: string }) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      access_token: pair.access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: pair.refresh,
    });
  };

  /** Audits a token event in the grant's workspace. */
  const auditToken = async (
    grant: OAuthGrant,
    event: 'token_issued' | 'token_refreshed' | 'token_revoked',
    detail: Record<string, unknown>,
  ) => {
    await gateway.appendSystemAudit(grant.workspaceId, {
      at: clock(),
      event,
      actor: 'system',
      connectionId: grant.connectionId,
      detail: { client_id: grant.clientId, ...detail },
    });
  };

  /** Refuses tokens for a connection that is blocked or gone. */
  const connectionUsable = async (grant: OAuthGrant): Promise<boolean> => {
    try {
      await gateway.connectGrant(grant, clock());
      return true;
    } catch (err) {
      if (err instanceof GatewayError) return false;
      throw err;
    }
  };

  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const oauthError = (
      c: Context,
      status: 400 | 401,
      error: string,
      description: string,
    ): Response => {
      logRefusal('warn', 'token request refused', {
        client_id: clip(form.client_id),
        grant_type: clip(form.grant_type, 40),
        error,
        description,
      });
      return sendOAuthError(c, status, error, description);
    };
    const client = await authenticateClient(c, form);
    if (!client)
      return oauthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret.');
    const now = clock();
    const resource = typeof form.resource === 'string' ? form.resource : undefined;
    if (resource !== undefined && !isOurResource(resource, publicUrl)) {
      return oauthError(
        c,
        400,
        'invalid_target',
        `This server only issues tokens for ${ep.resource}.`,
      );
    }

    if (form.grant_type === 'authorization_code') {
      const { code, redirect_uri: redirectUri, code_verifier: verifier } = form;
      if (typeof code !== 'string' || typeof verifier !== 'string') {
        return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required.');
      }
      const redeemed = await auth.redeemCode(hashToken(code), now);
      if (redeemed.status !== 'ok') {
        return oauthError(
          c,
          400,
          'invalid_grant',
          'The authorization code is invalid, expired or already used.',
        );
      }
      const grant = await auth.getGrantById(redeemed.code.grantId);
      if (
        !grant ||
        grant.clientId !== client.clientId ||
        // OAuth 2.1 §4.1.3: redirect_uri is required here if the authorization
        // request had one. Budd only fills it in when exactly one is registered.
        (typeof redirectUri === 'string'
          ? redirectUri
          : client.redirectUris.length === 1
            ? client.redirectUris[0]
            : undefined) !== redeemed.code.redirectUri ||
        !verifyPkce(verifier, redeemed.code.codeChallenge)
      ) {
        return oauthError(
          c,
          400,
          'invalid_grant',
          'The code doesn’t match this client, redirect URI or PKCE verifier.',
        );
      }
      if (!(await connectionUsable(grant))) {
        return oauthError(c, 400, 'invalid_grant', 'This connection has been blocked in Budd.');
      }
      const pair = newPair(now);
      await auth.issueTokens({
        ...pair.tokens,
        grantId: grant.id,
        familyId: redeemed.code.familyId,
        now,
      });
      await auditToken(grant, 'token_issued', { client_name: client.clientName });
      log.info('token issued', { client_id: client.clientId, connection_id: grant.connectionId });
      return tokenResponse(c, pair);
    }

    if (form.grant_type === 'refresh_token') {
      const refresh = form.refresh_token;
      if (typeof refresh !== 'string') {
        return oauthError(c, 400, 'invalid_request', 'refresh_token is required.');
      }
      const pair = newPair(now);
      const rotated = await auth.rotateRefreshToken({
        refreshHash: hashToken(refresh),
        clientId: client.clientId,
        next: pair.tokens,
        now,
      });
      if (rotated.status === 'reused' && rotated.grant) {
        log.warn('refresh token reused: token family revoked', {
          client_id: client.clientId,
          connection_id: rotated.grant.connectionId,
        });
        await auditToken(rotated.grant, 'token_revoked', { reason: 'refresh_token_reused' });
      }
      if (rotated.status !== 'ok') {
        return oauthError(
          c,
          400,
          'invalid_grant',
          'The refresh token is invalid, expired or already used. Sign in again.',
        );
      }
      if (!(await connectionUsable(rotated.grant))) {
        await auth.revokeToken(pair.tokens.accessHash, now);
        return oauthError(c, 400, 'invalid_grant', 'This connection has been blocked in Budd.');
      }
      await auditToken(rotated.grant, 'token_refreshed', {});
      log.info('token refreshed', {
        client_id: client.clientId,
        connection_id: rotated.grant.connectionId,
      });
      return tokenResponse(c, pair);
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  // RFC 7009: token revocation. Always 200, whether or not the token was known.
  app.post('/revoke', async (c) => {
    const form = await c.req.parseBody();
    const client = await authenticateClient(c, form);
    if (!client) {
      logRefusal('warn', 'revocation refused', { error: 'invalid_client' });
      return sendOAuthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret.');
    }
    if (typeof form.token === 'string') {
      const now = clock();
      const hash = hashToken(form.token);
      const grant = await auth.revokeToken(hash, now, client.clientId);
      if (grant) await auditToken(grant, 'token_revoked', { reason: 'client_request' });
      log.info('token revocation', { client_id: client.clientId, revoked: grant !== undefined });
    }
    return c.body(null, 200);
  });
}
