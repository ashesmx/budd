import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Bus } from '../bus/Bus.js';
import { durationInWords, localBaseUrl, type Config } from '../config.js';
import type { ConnectionKey, OAuthGrant } from '../domain/auth.js';
import { isValidSlug } from '../domain/slug.js';
import { auditFullMessage, createMcpServer } from '../mcp/server.js';
import { endpoints, oauthCors } from '../auth/oauth.js';
import { hashToken, KEY_PREFIX } from '../auth/tokens.js';
import { log, throttledLog } from '../log.js';
import { GatewayError, type ConnectionContext, type WorkspaceGateway } from '../storage/gateway.js';
import { AuditFullError, type AuthStore } from '../storage/Storage.js';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';

function jsonRpcError(c: Context, status: ContentfulStatusCode, message: string) {
  return c.json({ jsonrpc: '2.0', error: { code: -32600, message }, id: null }, status);
}

/** Serves one MCP request as `ctx`: stateless, so every request stands alone. */
async function serveMcp(c: Context, bus: Bus, ctx: ConnectionContext, config: Config) {
  // Parsed here, once, so a batch can be refused: MCP_RATE_PER_MIN counts
  // requests, and a batch of 100 calls must not pass as one. MCP dropped
  // batching in its 2025-06-18 revision, and clients don't batch.
  let parsedBody: unknown;
  if (c.req.method === 'POST') {
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: the body isn’t JSON.' },
          id: null,
        },
        400,
      );
    }
    if (Array.isArray(parsedBody)) {
      return jsonRpcError(
        c,
        400,
        'Send one JSON-RPC message per request: Budd doesn’t accept batches.',
      );
    }
  }
  const server = createMcpServer(bus, ctx, config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw, { parsedBody });
  } finally {
    await server.close();
  }
}

export function mountMcp(
  app: Hono,
  deps: {
    config: Config;
    gateway: WorkspaceGateway;
    bus: Bus;
    auth: AuthStore;
    clock: () => number;
  },
): void {
  const { config, gateway, bus, auth, clock } = deps;
  const example = `${localBaseUrl(config)}/mcp/claude-desktop`;
  const logRefusal = throttledLog(60, clock);

  // Checked before the connection is looked up or touched, so a flood that's
  // refused costs no database writes.
  const perConnection = new TokenBucketRateLimiter(config.limits.mcpRatePerMin, 60_000, 100_000);
  const overLimit = (c: Context, key: string, now: number, fields: Record<string, string>) => {
    if (perConnection.tryConsume(key, now)) return undefined;
    logRefusal('warn', 'mcp rate limited', { ...fields, limit: 'MCP_RATE_PER_MIN' });
    c.header('Retry-After', '60');
    return jsonRpcError(
      c,
      429,
      `Too many requests: a connection may make ${String(config.limits.mcpRatePerMin)} a minute (MCP_RATE_PER_MIN), shared by all its handles. Wait a minute, and poll inbox_count less often.`,
    );
  };

  if (config.hosted) {
    // Hosted mode: the connection comes from the OAuth access token (§2).
    const { resourceMetadata } = endpoints(config.hosted.publicUrl);
    const refusals = {
      none: 'Sign in with OAuth to use Budd, or send an API key a human created in the Budd UI.',
      token: 'The access token is invalid or expired.',
      key: 'This API key is unknown or has been revoked. A human can create a new one on the connection’s page in the Budd UI.',
      'expired key': `This API key expired after going unused (keys stop after ${durationInWords(config.keyIdleExpiryMs)} unused). Ask your human for a new key from the connection’s page in the Budd UI; its mailboxes and messages are kept.`,
    };
    const unauthorized = (c: Context, refused: keyof typeof refusals = 'none') => {
      c.header(
        'WWW-Authenticate',
        // A refused key gets no pointer to OAuth: a client must not answer it with a browser sign-in.
        refused === 'key' || refused === 'expired key'
          ? 'Bearer error="invalid_token"'
          : `Bearer resource_metadata="${resourceMetadata}"${refused === 'token' ? ', error="invalid_token"' : ''}`,
      );
      return jsonRpcError(c, 401, refusals[refused]);
    };
    app.use('/mcp', oauthCors);
    app.use('/mcp/*', oauthCors);
    app.all('/mcp', async (c) => {
      const header = c.req.header('authorization') ?? '';
      const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      if (token === undefined) {
        // Normal on first contact: the 401 is how a client discovers OAuth.
        logRefusal('info', 'mcp request without a token', { has_authorization: header !== '' });
        return unauthorized(c);
      }
      // An API key (ADR 0016) or an OAuth access token: both name one connection.
      const isKey = token.startsWith(`${KEY_PREFIX}_`);
      const now = clock();
      const approval = isKey
        ? await auth.useConnectionKey(hashToken(token), now, config.keyIdleExpiryMs)
        : (await auth.findAccessToken(hashToken(token), now))?.grant;
      if (approval === 'expired') {
        logRefusal('warn', 'mcp api key rejected', { reason: 'expired' });
        return unauthorized(c, 'expired key');
      }
      if (!approval) {
        logRefusal('warn', isKey ? 'mcp api key rejected' : 'mcp access token rejected', {
          reason: isKey ? 'unknown or revoked' : 'unknown, expired or revoked',
        });
        return unauthorized(c, isKey ? 'key' : 'token');
      }
      const limited = overLimit(c, approval.connectionId, now, {
        workspace_id: approval.workspaceId,
        connection_id: approval.connectionId,
      });
      if (limited) return limited;
      let ctx;
      try {
        ctx = await (isKey
          ? gateway.connectKey(approval as ConnectionKey, now)
          : gateway.connectGrant(approval as OAuthGrant, now));
      } catch (err) {
        if (err instanceof GatewayError) {
          log.warn('mcp connection refused', {
            reason: err.code,
            ...(isKey ? { via: 'api_key' } : { client_id: (approval as OAuthGrant).clientId }),
            connection_id: approval.connectionId,
          });
          return jsonRpcError(c, 403, err.message);
        }
        throw err;
      }
      return serveMcp(c, bus, ctx, config);
    });
    app.all('/mcp/*', (c) =>
      jsonRpcError(c, 404, `In hosted mode the MCP URL is ${config.hosted?.publicUrl ?? ''}/mcp.`),
    );
    return;
  }

  const missingName = (c: Context) =>
    jsonRpcError(
      c,
      400,
      `Add a connection name to the URL, e.g. ${example}. Give each AI app its own name of your choosing (e.g. claude-desktop, grok-build): lowercase letters, digits and hyphens.`,
    );
  app.all('/mcp', missingName);
  app.all('/mcp/', missingName);

  app.all('/mcp/:connection', async (c) => {
    // Budd's transport is stateless: there's no GET stream or DELETE. Refusing
    // them before the connection is looked up matters, because a web page can
    // make a browser send a GET (an <img>, say) with no Origin header, which
    // would otherwise create a connection named by that page.
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return jsonRpcError(c, 405, 'Method not allowed: MCP requests are POSTs.');
    }
    // MCP clients aren't browsers and send no Sec-Fetch-Site; a browser does,
    // so a request a web page caused is refused before any connection exists.
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return jsonRpcError(c, 403, 'Refused: a web page may not call Budd’s MCP endpoint.');
    }
    const name = c.req.param('connection');
    const now = clock();
    // A name that can't be a connection is refused below without a bucket of its own.
    const limited = isValidSlug(name) && overLimit(c, name, now, { connection: name });
    if (limited) return limited;
    let ctx;
    try {
      ctx = await gateway.connectLocal(name, now);
    } catch (err) {
      if (err instanceof GatewayError) {
        const refused = err.code === 'blocked' || err.code === 'connection_limit';
        if (err.code === 'connection_limit') {
          logRefusal('warn', 'mcp connection refused', { reason: err.code, connection: name });
        }
        return jsonRpcError(c, refused ? 403 : 400, err.message);
      }
      if (err instanceof AuditFullError) {
        logRefusal('warn', 'agent refused: audit log full', {
          workspace: 'local',
          connection: name,
          limit: 'MAX_AUDIT_MB',
        });
        return jsonRpcError(c, 403, auditFullMessage(err));
      }
      throw err;
    }
    return serveMcp(c, bus, ctx, config);
  });

  app.all('/mcp/*', (c) =>
    jsonRpcError(c, 400, `Invalid MCP URL. Use /mcp/<connection>, e.g. ${example}.`),
  );
}
