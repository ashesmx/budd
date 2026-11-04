import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/tokens.js';
import {
  authorizeUrl,
  Browser,
  CALLBACK,
  connectClient,
  consent,
  continueTarget,
  decide,
  field,
  mcpAs,
  pkce,
  rawMcp,
  register,
  startHostedBudd,
  token,
  type HostedBudd,
  returnLink,
  unescapeHtml,
} from './helpers/hosted.js';

let budd: HostedBudd;
const alice = { sub: 'alice-sub', email: 'alice@example.com' };
const bob = { sub: 'bob-sub', email: 'bob@example.org' };

beforeEach(async () => {
  budd = await startHostedBudd();
});
afterEach(async () => {
  await budd.close();
});

const json = async (p: string) => (await fetch(budd.url + p)).json();
const accountOf = async (email: string) => {
  const r = await budd.internals.storage.auth.signIn({
    issuer: budd.idp.issuer,
    subject: email === alice.email ? alice.sub : bob.sub,
    email,
    slugBase: 'x',
    now: budd.clock.now,
  });
  return r;
};

describe('discovery (MCP authorization spec)', () => {
  it('serves protected resource and authorization server metadata', async () => {
    const resource = await json('/.well-known/oauth-protected-resource/mcp');
    expect(resource).toMatchObject({
      resource: `${budd.url}/mcp`,
      authorization_servers: [budd.url],
    });
    expect(await json('/.well-known/oauth-protected-resource')).toEqual(resource);
    expect(await json('/.well-known/oauth-authorization-server')).toMatchObject({
      issuer: budd.url,
      authorization_endpoint: `${budd.url}/authorize`,
      token_endpoint: `${budd.url}/token`,
      registration_endpoint: `${budd.url}/register`,
      revocation_endpoint: `${budd.url}/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });

  it('answers an unauthenticated /mcp with 401 and a pointer to the metadata', async () => {
    const res = await rawMcp(budd);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${budd.url}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await rawMcp(budd, 'budd_at_nope');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
  });

  it('allows browser-based clients (CORS) on the machine endpoints, not the UI', async () => {
    const pre = await fetch(`${budd.url}/token`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const meta = await fetch(`${budd.url}/.well-known/oauth-authorization-server`);
    expect(meta.headers.get('access-control-allow-origin')).toBe('*');
    const mcp = await rawMcp(budd);
    expect(mcp.headers.get('access-control-expose-headers')).toMatch(/www-authenticate/);
    const ui = await fetch(`${budd.url}/ui`, { redirect: 'manual' });
    expect(ui.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('MCP requests without MCP-Protocol-Version', () => {
  // Some clients (Grok Bot, via Cursor) omit the header after initializing.
  // The spec says to assume the negotiated or default version, not to refuse.
  const post = (access: string, headers: Record<string, string>) =>
    fetch(`${budd.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${access}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

  it('serves a request that omits the header, even with a stale session id', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { access } = await connectClient(budd, b);
    const stale = { 'mcp-session-id': 'from-an-earlier-session' };
    for (const headers of [{}, stale] as Record<string, string>[]) {
      const res = await post(access, headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((t) => t.name)).toContain('whoami');
    }
  });

  it('still refuses a version it doesn’t support', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { access } = await connectClient(budd, b);
    const res = await post(access, { 'mcp-protocol-version': '1999-01-01' });
    expect(res.status).toBe(400);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const r = await register(budd);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
    });
    expect(r.body.client_id).toMatch(/^budd_client_/);
    expect(r.body.client_secret).toBeUndefined();
  });

  it('issues a secret when the client asks for one (or by default, per RFC 7591)', async () => {
    const r = await register(budd, { token_endpoint_auth_method: undefined });
    expect(r.body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(r.body.client_secret).toMatch(/^budd_cs_/);
  });

  it.each([
    ['http on a public host', 'http://example.com/cb'],
    ['a fragment', 'https://example.com/cb#x'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['not a URL', 'nope'],
  ])('rejects a redirect URI with %s', async (_, uri) => {
    const r = await register(budd, { redirect_uris: [uri] });
    expect(r.status).toBe(400);
  });

  it.each([
    ['https', 'https://claude.ai/api/mcp/auth_callback'],
    ['loopback http', 'http://localhost:33418/callback'],
    ['an app scheme', 'cursor://anysphere.cursor-retrieval/oauth/callback'],
  ])('accepts %s redirect URIs', async (_, uri) => {
    expect((await register(budd, { redirect_uris: [uri] })).status).toBe(201);
  });

  it('keeps and echoes only the metadata Budd uses', async () => {
    const r = await register(budd, {
      software_statement: 'x'.repeat(4000),
      contacts: ['a@example.com'],
      jwks: { keys: [] },
    });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('software_statement');
    expect(r.body).not.toHaveProperty('contacts');
    expect(r.body).not.toHaveProperty('jwks');
    const stored = await budd.internals.storage.auth.getClient(r.body.client_id as string);
    expect(JSON.stringify(stored?.metadata)).not.toContain('xxxx');
  });

  it('caps the number and length of redirect URIs', async () => {
    const many = Array.from({ length: 6 }, (_, i) => `https://example.com/cb${String(i)}`);
    expect((await register(budd, { redirect_uris: many })).status).toBe(400);
    const long = `https://example.com/${'a'.repeat(2048)}`;
    expect((await register(budd, { redirect_uris: [long] })).status).toBe(400);
  });

  it('refuses a registration body over 16 KiB', async () => {
    const r = await register(budd, { software_statement: 'x'.repeat(17 * 1024) });
    expect(r.status).toBe(413);
  });

  it('purges the oldest never-authorized clients beyond the cap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      budd.clock.now += 1000;
      ids.push(((await register(budd)).body as { client_id: string }).client_id);
    }
    const store = budd.internals.storage.auth;
    await store.purge({
      now: budd.clock.now,
      staleClientsBefore: 0,
      maxUnauthorizedClients: 2,
      recentClientsAfter: budd.clock.now,
    });
    expect(await store.getClient(ids[0] ?? '')).toBeUndefined();
    expect(await store.getClient(ids[1] ?? '')).toBeUndefined();
    expect(await store.getClient(ids[2] ?? '')).toBeDefined();
    expect(await store.getClient(ids[3] ?? '')).toBeDefined();
  });

  it('never purges a registration from the last hour to make room (a flood can’t evict an app mid-consent)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      budd.clock.now += 1000;
      ids.push(((await register(budd)).body as { client_id: string }).client_id);
    }
    const store = budd.internals.storage.auth;
    await store.purge({
      now: budd.clock.now,
      staleClientsBefore: 0,
      maxUnauthorizedClients: 1,
      recentClientsAfter: budd.clock.now - 1500, // only the first is older than "recent"
    });
    expect(await store.getClient(ids[0] ?? '')).toBeUndefined();
    expect(await store.getClient(ids[1] ?? '')).toBeDefined();
    expect(await store.getClient(ids[2] ?? '')).toBeDefined();
  });

  it('accepts the largest registration its own caps allow', async () => {
    const uris = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/${String(i)}${'a'.repeat(2000)}`,
    );
    expect((await register(budd, { redirect_uris: uris })).status).toBe(201);
  });

  it('rejects unsupported grant types', async () => {
    const r = await register(budd, { grant_types: ['client_credentials'] });
    expect(r.status).toBe(400);
  });
});

describe('the authorization code flow', () => {
  it('signs in, provisions a personal workspace from the email, and connects the client', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { access } = await connectClient(budd, b);
    const agent = await mcpAs(budd, access);
    expect(await agent.ok('whoami')).toMatchObject({
      workspace: 'alice',
      connection: 'claude',
      connection_verified: true,
      mode: 'hosted',
    });
    await agent.close();
  });

  it('slugs connections from client_name, suffixing collisions, and reuses them on re-authorization', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const first = await connectClient(budd, b, 'Claude');
    const second = await connectClient(budd, b, 'Claude');
    const grok = await connectClient(budd, b, 'Grok Build');
    const slugs = [];
    for (const t of [first, second, grok]) {
      const a = await mcpAs(budd, t.access);
      slugs.push((await a.ok('whoami')).connection);
      await a.close();
    }
    expect(slugs).toEqual(['claude', 'claude-2', 'grok-build']);

    // The same client authorizing again keeps its connection.
    const { verifier, challenge } = pkce();
    const back = await consent(b, first.clientId, challenge);
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: first.clientId,
    });
    const again = await mcpAs(budd, t.body.access_token);
    expect((await again.ok('whoami')).connection).toBe('claude');
    await again.close();
  });

  it('returns the state and issuer with the code', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const back = await consent(b, client.client_id, pkce().challenge);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(budd.url);
  });

  it('sends the user to sign in first, then back to the consent screen', async () => {
    const { body: client } = await register(budd);
    const b = new Browser(budd);
    budd.idp.user = alice;
    const landing = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(landing.body).toContain('<h1>Sign in to Budd</h1>');
    const page = await b.post('/login', [['return', field(landing.body, 'return')]]);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Connect <q>Claude</q> to Budd?');
    expect(page.body).toContain('unverified');
  });

  it('reports a denial to the client', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const back = await consent(b, client.client_id, pkce().challenge, 'deny');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('never redirects to an unregistered redirect URI', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const page = await b.go(
      authorizeUrl(client.client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }),
    );
    expect(page.status).toBe(400);
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1/);
    const unknown = await b.go(authorizeUrl('budd_client_nope', pkce().challenge));
    expect(unknown.status).toBe(400);
  });

  it('requires PKCE S256', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const good = pkce().challenge;
    for (const [challenge, extra] of [
      [good, { code_challenge_method: 'plain' }],
      ['', {}],
      ['too-short', {}],
    ] as const) {
      const page = await b.go(authorizeUrl(client.client_id, challenge, extra));
      expect(page.status).toBe(400);
      expect(page.body).toContain('invalid_request');
    }
  });

  it('refuses a resource other than Budd’s MCP endpoint', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const page = await b.go(
      authorizeUrl(client.client_id, pkce().challenge, { resource: 'https://other.example/mcp' }),
    );
    expect(page.status).toBe(400);
    expect(page.body).toContain('invalid_target');
  });

  it('shows request errors on a page, never redirecting before consent (no open redirect)', async () => {
    // Anyone can register any https redirect URI, so it can't be trusted yet.
    const { body: client } = await register(budd, { redirect_uris: ['https://evil.example/cb'] });
    const res = await fetch(
      budd.url +
        authorizeUrl(client.client_id, pkce().challenge, {
          redirect_uri: 'https://evil.example/cb',
          response_type: 'token',
        }),
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('unsupported_response_type');
  });

  it('warns on the consent screen when the app returns to this computer', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const same = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(same.body).toContain('a program on your own computer');
    expect(same.body).not.toContain('registered a different port');
    const other = await b.go(
      authorizeUrl(client.client_id, pkce().challenge, {
        redirect_uri: CALLBACK.replace(':1/', ':2/'),
      }),
    );
    expect(other.body).toContain('registered a different port');
    const { body: web } = await register(budd, {
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    const remote = await b.go(
      authorizeUrl(web.client_id, pkce().challenge, {
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }),
    );
    expect(remote.body).not.toContain('a program on your own computer');
  });

  it('lets the consent form post only to Budd itself', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const page = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self';");
  });

  it('denies on Enter: Deny is the consent form’s first button, and has the focus', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const page = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(page.body.match(/<button[^>]*>/)?.[0]).toBe(
      '<button class="later" name="decision" value="deny" autofocus>',
    );
  });
});

describe('returning to the client after consent (ADR 0014)', () => {
  // Browsers apply form-action to every redirect after a form POST, so the
  // decision answers with a page that navigates to the client afresh.
  const decideAndCheckReturnPage = async (
    b: Browser,
    clientId: string,
    decision: 'approve' | 'deny',
    redirectUri = CALLBACK,
  ) => {
    const page = await b.go(
      authorizeUrl(clientId, pkce().challenge, { redirect_uri: redirectUri }),
    );
    expect(page.status).toBe(200);
    const back = await decide(b, page, decision);
    expect(back.status).toBe(200);
    expect(back.url).toBe(`${budd.url}/authorize`);
    expect(back.headers.get('location')).toBeNull();
    expect(back.headers.get('cache-control')).toBe('no-store');
    expect(back.headers.get('referrer-policy')).toBe('same-origin');
    expect(back.headers.get('content-security-policy')).toContain("form-action 'self';");
    const { refresh, link } = continueTarget(back.body);
    expect(link).toBe(refresh);
    return { body: back.body, target: refresh ?? '' };
  };
  const iss = () => encodeURIComponent(budd.url);

  it('approve: a page that sends the code, state and issuer to the redirect URI', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const { body, target } = await decideAndCheckReturnPage(b, client.client_id, 'approve');
    const code = new URL(target).searchParams.get('code') ?? '';
    expect(code).toMatch(/^budd_code_/);
    expect(target).toBe(`${CALLBACK}?code=${code}&state=xyz&iss=${iss()}`);
    expect(body).toContain('<h1>Returning to the app</h1>');
    expect(body).toContain('Returning you to <code>127.0.0.1:1</code>…');
    expect(body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // nothing off-site
  });

  it('deny: a page that sends access_denied', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const { body, target } = await decideAndCheckReturnPage(b, client.client_id, 'deny');
    expect(body).toContain('You declined, so nothing was connected.');
    expect(target).toBe(
      `${CALLBACK}?error=access_denied&error_description=The+user+declined.&state=xyz&iss=${iss()}`,
    );
  });

  it('blocked connection: a page that stays, says how to fix it, and links back to the app', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b);
    const { account, workspaces } = await accountOf(alice.email);
    const ctx = await budd.internals.gateway.adminForAccount(account.id, workspaces[0]?.id ?? '');
    await budd.admin.block(ctx, 'claude');
    const page = await b.go(authorizeUrl(t.clientId, pkce().challenge));
    const back = await decide(b, page, 'approve');
    expect(back.status).toBe(403);
    expect(back.headers.get('cache-control')).toBe('no-store');
    expect(continueTarget(back.body).refresh).toBeUndefined();
    expect(back.body).toContain('<q>Claude</q> wasn’t connected');
    expect(back.body).toContain('Its connection is blocked.');
    expect(back.body.replace(/\s+/g, ' ')).toContain(
      'href="/ui/connections/claude" >Open connection claude</a >',
    );
    expect(returnLink(back.body)).toBe(
      `${CALLBACK}?error=access_denied&error_description=This+connection+has+been+blocked+in+Budd.+Unblock+it+in+the+Budd+UI+first.&state=xyz&iss=${iss()}`,
    );
    expect(back.body).not.toContain('budd_code_');
  });

  it('escapes a hostile but validly registered redirect URI', async () => {
    // Registration is open: quotes, angle brackets and & are all allowed.
    const hostile = `https://evil.example/a'b"c<script>x</script>&d/cb?q='"><img src=x>`;
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd, { redirect_uris: [hostile] });
    const { body, target } = await decideAndCheckReturnPage(b, client.client_id, 'deny', hostile);
    const expected = new URL(hostile);
    expected.searchParams.set('error', 'access_denied');
    expected.searchParams.set('error_description', 'The user declined.');
    expected.searchParams.set('state', 'xyz');
    expected.searchParams.set('iss', budd.url);
    expect(target).toBe(expected.toString());
    expect(target).toContain("a'b"); // survives URL serialization, so HTML must escape it
    expect(body).toContain('a&#39;b');
    expect(body).not.toContain('<script>x');
    expect(body).not.toContain('<img src=x');
  });

  it('works for an app-specific scheme too', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const uri = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const { body: client } = await register(budd, { redirect_uris: [uri] });
    const { body, target } = await decideAndCheckReturnPage(b, client.client_id, 'deny', uri);
    expect(target.startsWith(`${uri}?error=access_denied&`)).toBe(true);
    expect(body).toContain('<h1>Opening the app</h1>');
    expect(body).toContain('back to the app (<code>cursor:</code>)');
    expect(body).toContain('Nothing happened?');
  });
});

describe('the token endpoint', () => {
  const codeFor = async (b: Browser) => {
    const { body: client } = await register(budd);
    const { verifier, challenge } = pkce();
    const back = await consent(b, client.client_id, challenge);
    return { client, verifier, code: back.searchParams.get('code') ?? '' };
  };

  it('rejects a wrong PKCE verifier', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { client, code } = await codeFor(b);
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: pkce().verifier,
      client_id: client.client_id,
    });
    expect(t).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('rejects a code redeemed twice, and revokes what the first redemption issued', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { client, verifier, code } = await codeFor(b);
    const fields = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: client.client_id,
    };
    const first = await token(budd, fields);
    expect(first.status).toBe(200);
    expect((await rawMcp(budd, first.body.access_token)).status).toBe(200);
    expect((await token(budd, fields)).body.error).toBe('invalid_grant');
    expect((await rawMcp(budd, first.body.access_token)).status).toBe(401);
  });

  it('requires redirect_uri when the client registered more than one', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd, {
      redirect_uris: [CALLBACK, 'https://claude.ai/api/mcp/auth_callback'],
    });
    const { verifier, challenge } = pkce();
    const back = await consent(b, client.client_id, challenge);
    const fields = {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      code_verifier: verifier,
      client_id: client.client_id,
    };
    expect((await token(budd, fields)).body.error).toBe('invalid_grant');
  });

  it('may omit redirect_uri when the client registered exactly one', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { client, verifier, code } = await codeFor(b);
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(t.status).toBe(200);
  });

  it('answers malformed Basic credentials with invalid_client, not a server error', async () => {
    const basic = Buffer.from('%E0%A4%A:secret').toString('base64');
    const t = await token(
      budd,
      { grant_type: 'authorization_code', code: 'x' },
      { authorization: `Basic ${basic}` },
    );
    expect(t.status).toBe(401);
    expect(t.body.error).toBe('invalid_client');
  });

  it('rejects an expired code', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { client, verifier, code } = await codeFor(b);
    budd.clock.now += 5 * 60_000;
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(t.body.error).toBe('invalid_grant');
  });

  it('rejects a code presented by a different client', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { verifier, code } = await codeFor(b);
    const { body: other } = await register(budd);
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: other.client_id,
    });
    expect(t.body.error).toBe('invalid_grant');
  });

  it('authenticates confidential clients', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd, {
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const { verifier, challenge } = pkce();
    const code = (await consent(b, client.client_id, challenge)).searchParams.get('code') ?? '';
    const fields = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    };
    const basic = (secret: string) => ({
      authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString('base64')}`,
    });
    expect((await token(budd, fields, basic('wrong'))).status).toBe(401);
    expect((await token(budd, { ...fields, client_id: client.client_id })).status).toBe(401);
    expect((await token(budd, fields, basic(client.client_secret))).status).toBe(200);
  });

  it('access tokens expire after an hour', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { access } = await connectClient(budd, b);
    budd.clock.now += 3600_000;
    expect((await rawMcp(budd, access)).status).toBe(401);
  });
});

describe('tokens are stored hashed', () => {
  it('never writes a token, code or client secret to disk in plaintext', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd, {
      token_endpoint_auth_method: 'client_secret_post',
    });
    const { verifier, challenge } = pkce();
    const code = (await consent(b, client.client_id, challenge)).searchParams.get('code') ?? '';
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const secrets = [t.body.access_token, t.body.refresh_token, code, client.client_secret];
    const files = ['control.db', 'control.db-wal'].map((f) => path.join(budd.dataDir, f));
    const raw = files
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString('latin1'))
      .join('');
    for (const s of secrets) {
      expect(raw, 'plaintext secret on disk').not.toContain(s);
    }
    expect(raw).toContain(hashToken(t.body.access_token));
    expect(raw).toContain(hashToken(t.body.refresh_token));
  });
});

describe('refresh token rotation', () => {
  const refresh = (clientId: string, refreshToken: string) =>
    token(budd, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });

  it('issues a new pair and retires the old one', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const first = await connectClient(budd, b);
    const r = await refresh(first.clientId, first.refresh);
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(first.refresh);
    expect((await rawMcp(budd, r.body.access_token)).status).toBe(200);
    expect((await rawMcp(budd, first.access)).status).toBe(401);
  });

  it('treats reuse of a retired refresh token as theft: the whole family is revoked', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const first = await connectClient(budd, b);
    const second = await refresh(first.clientId, first.refresh);
    const replay = await refresh(first.clientId, first.refresh);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await rawMcp(budd, second.body.access_token)).status).toBe(401);
    expect((await refresh(first.clientId, second.body.refresh_token)).body.error).toBe(
      'invalid_grant',
    );
  });

  it('only the client that owns a refresh token can use it', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const first = await connectClient(budd, b);
    const { body: other } = await register(budd);
    expect((await refresh(other.client_id, first.refresh)).body.error).toBe('invalid_grant');
    expect((await refresh(first.clientId, first.refresh)).status).toBe(200);
  });

  it('refresh tokens expire after 30 days', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const first = await connectClient(budd, b);
    budd.clock.now += 30 * 24 * 3600_000;
    expect((await refresh(first.clientId, first.refresh)).body.error).toBe('invalid_grant');
  });
});

describe('revocation', () => {
  const revoke = (clientId: string, t: string) =>
    fetch(`${budd.url}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t, client_id: clientId }).toString(),
    });

  it('revoking the refresh token also kills the access token (RFC 7009)', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b);
    expect((await revoke(t.clientId, t.refresh)).status).toBe(200);
    expect((await rawMcp(budd, t.access)).status).toBe(401);
  });

  it('a client cannot revoke another client’s tokens', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b);
    const { body: other } = await register(budd);
    expect((await revoke(other.client_id, t.access)).status).toBe(200);
    expect((await rawMcp(budd, t.access)).status).toBe(200);
  });

  it('blocking a connection kills its tokens; it can’t re-authorize until unblocked', async () => {
    const b = new Browser(budd);
    const signedIn = await b.signIn(alice);
    expect(signedIn.status).toBe(200);
    const t = await connectClient(budd, b);
    const { account, workspaces } = await accountOf(alice.email);
    const ctx = await budd.internals.gateway.adminForAccount(account.id, workspaces[0]?.id ?? '');
    await budd.admin.block(ctx, 'claude');

    expect((await rawMcp(budd, t.access)).status).toBe(401);
    expect(
      (
        await token(budd, {
          grant_type: 'refresh_token',
          refresh_token: t.refresh,
          client_id: t.clientId,
        })
      ).body.error,
    ).toBe('invalid_grant');
    const page = await b.go(authorizeUrl(t.clientId, pkce().challenge));
    expect((await decide(b, page, 'approve')).status).toBe(403);

    await budd.admin.unblock(ctx, 'claude', { confirmed: true });
    expect((await rawMcp(budd, t.access)).status).toBe(401); // old tokens stay dead
    const audit = (await budd.admin.audit(ctx, 100)).map((e) => e.event);
    expect(audit).toContain('token_revoked');
  });
});

describe('the landing page', () => {
  it('shows a landing page instead of going straight to the provider', async () => {
    const b = new Browser(budd);
    const page = await b.go('/ui');
    expect(page.status).toBe(200);
    expect(page.url).toBe(`${budd.url}/login?return=%2Fui&bounced=1`); // never left Budd
    expect(page.body).toContain('<h1>Sign in to Budd</h1>');
    expect(page.body).toContain(`<code>${new URL(budd.idp.issuer).host}</code>`);
    expect(page.body).toContain(`<code>${budd.url}/mcp</code>`);
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(page.body).toContain('<form method="post" action="/login" class="actions">');
    expect(field(page.body, 'return')).toBe('/ui');
    budd.idp.user = alice;
    const signedIn = await b.post('/login', [['return', '/ui']]);
    expect(signedIn.url).toBe(`${budd.url}/ui`);
  });

  it('shows it on the way to an app’s consent screen too, and skips it once signed in', async () => {
    const b = new Browser(budd);
    budd.idp.user = alice;
    const authorize = '/authorize?client_id=x';
    const landing = await b.go(`/login?return=${encodeURIComponent(authorize)}`);
    expect(landing.body).toContain('<h1>Sign in to Budd</h1>');
    expect(field(landing.body, 'return')).toBe(authorize);
    expect((await b.post('/login', [['return', authorize]])).url).toBe(`${budd.url}${authorize}`);
    expect((await b.go('/login?return=/ui')).url).toBe(`${budd.url}/ui`);
  });

  it('never starts a sign-in from a link, or from a form on another site', async () => {
    budd.idp.user = alice;
    // An old "start" link only shows the landing page.
    const link = await new Browser(budd).go('/login?return=/ui&start=1');
    expect(link.body).toContain('<h1>Sign in to Budd</h1>');
    const post = (headers: Record<string, string>) =>
      fetch(`${budd.url}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: 'return=%2Fui',
        redirect: 'manual',
      });
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('names an allowed domain only when it is the one the provider is told anyway', async () => {
    await budd.close();
    budd = await startHostedBudd({ ALLOWED_HD: 'example.com' });
    expect((await new Browser(budd).go('/ui')).body).toContain(
      'with your <code>example.com</code> account.',
    );
    await budd.close();
    budd = await startHostedBudd({ ALLOWED_HD: 'example.com, secret-acquisition.example' });
    expect((await new Browser(budd).go('/ui')).body).not.toContain('example.com');
  });
});

describe('sign-in and domain restriction', () => {
  it('audits logins in the account’s workspace', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { account, workspaces } = await accountOf(alice.email);
    const ctx = await budd.internals.gateway.adminForAccount(account.id, workspaces[0]?.id ?? '');
    const login = (await budd.admin.audit(ctx, 100)).find((e) => e.event === 'login');
    expect(login).toMatchObject({
      actor: 'human',
      detail: { email: alice.email, new_account: true },
    });
  });

  it('requires a verified email', async () => {
    const page = await new Browser(budd).signIn({ ...alice, email_verified: false });
    expect(page.status).toBe(403);
    expect(page.body).toMatch(/no verified email/);
  });

  it.each(['bad-signature', 'wrong-audience', 'wrong-issuer', 'expired', 'wrong-nonce'] as const)(
    'rejects an ID token with %s',
    async (tamper) => {
      budd.idp.tamper = tamper;
      const b = new Browser(budd);
      const page = await b.signIn(alice);
      expect(page.status).toBe(403);
      budd.idp.tamper = undefined;
      // Not signed in: the UI still asks for a sign-in.
      const ui = await fetch(`${budd.url}/ui`, { redirect: 'manual' });
      expect(ui.status).toBe(302);
    },
  );

  it('refuses a callback with no sign-in in progress', async () => {
    const page = await new Browser(budd).go('/auth/callback?code=x&state=forged');
    expect(page.status).toBe(400);
  });

  it('refuses a callback whose state doesn’t match the sign-in in progress (login CSRF)', async () => {
    // Start a sign-in by hand so we can tamper with the IdP's redirect back.
    const start = await fetch(`${budd.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: budd.url },
      body: 'return=%2Fui',
      redirect: 'manual',
    });
    const loginCookie = (start.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
    budd.idp.user = alice;
    const idpUrl = continueTarget(await start.text()).refresh ?? '';
    const idp = await fetch(idpUrl, { redirect: 'manual' });
    const back = new URL(idp.headers.get('location') ?? '');
    expect(back.searchParams.get('code')).toBeTruthy();
    back.searchParams.set('state', 'attacker-state');
    const res = await fetch(back, { redirect: 'manual', headers: { cookie: loginCookie } });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('budd_session='))).toBe(false);
  });

  describe('with ALLOWED_EMAILS', () => {
    beforeEach(async () => {
      await budd.close();
      budd = await startHostedBudd({ ALLOWED_EMAILS: 'bob@elsewhere.example, @example.com' });
    });

    it.each([
      ['a listed address', 'Bob@elsewhere.example', {}],
      [
        'an address in a listed @domain, from its Workspace',
        'carol@example.com',
        { hd: 'example.com' },
      ],
    ])('lets in %s', async (_, email, extra) => {
      const page = await new Browser(budd).signIn({ sub: email, email, ...extra });
      expect(page.status).toBe(200);
      expect(page.url).toMatch(/\/ui$/);
    });

    it.each([
      ['another address', 'dave@elsewhere.example', {}],
      ['a subdomain of a listed domain', 'erin@mail.example.com', { hd: 'example.com' }],
      // Anyone who once had mail at the domain can make one of these.
      ['a personal Google account at a listed @domain', 'frank@example.com', {}],
      [
        'a listed address the provider hasn’t verified',
        'bob@elsewhere.example',
        { email_verified: false },
      ],
    ])('refuses %s, without naming who is allowed', async (_, email, extra) => {
      const page = await new Browser(budd).signIn({ sub: email, email, ...extra });
      expect(page.status).toBe(403);
      expect(unescapeHtml(page.body)).toMatch(
        'email_verified' in extra ? /no verified email/ : `${email} can't sign in to this Budd`,
      );
      expect(page.body).not.toContain('Only accounts from');
      if (!email.startsWith('bob@')) expect(page.body).not.toContain('bob@');
    });
  });

  it('with ALLOWED_HD and ALLOWED_EMAILS, lets in either and names neither', async () => {
    await budd.close();
    budd = await startHostedBudd({
      ALLOWED_HD: 'example.com',
      ALLOWED_EMAILS: 'bob@elsewhere.example',
    });
    const member = await new Browser(budd).signIn({ ...alice, hd: 'example.com' });
    expect(member.status).toBe(200);
    expect(budd.idp.lastAuthorize?.hd).toBeUndefined();
    const bob = 'bob@elsewhere.example';
    expect((await new Browser(budd).signIn({ sub: 'bob', email: bob })).status).toBe(200);
    expect((await new Browser(budd).go('/ui')).body).not.toContain('example.com');
  });

  describe('with ALLOWED_HD', () => {
    beforeEach(async () => {
      await budd.close();
      budd = await startHostedBudd({ ALLOWED_HD: 'example.com, example.net' });
    });

    it('lets in accounts from an allowed domain (checked server-side from the hd claim)', async () => {
      const page = await new Browser(budd).signIn({ ...alice, hd: 'example.com' });
      expect(page.status).toBe(200);
      expect(page.url).toMatch(/\/ui$/);
    });

    it.each([
      ['another domain', { hd: 'evil.example' }],
      ['no hd claim (a personal account)', {}],
      ['an email that merely looks right', { email: 'mallory@example.com' }],
    ])('refuses %s', async (_, extra) => {
      const page = await new Browser(budd).signIn({ sub: 'm', email: 'm@evil.example', ...extra });
      expect(page.status).toBe(403);
      expect(unescapeHtml(page.body)).toContain("can't sign in to this Budd");
      expect(page.body).not.toContain('example.net');
    });
  });
});

describe('two accounts are fully isolated', () => {
  it('each gets its own workspace, and nothing crosses between them', async () => {
    const ab = new Browser(budd);
    await ab.signIn(alice);
    const bb = new Browser(budd);
    await bb.signIn(bob);
    const aliceClaude = await connectClient(budd, ab);
    const bobClaude = await connectClient(budd, bb);
    const a = await mcpAs(budd, aliceClaude.access);
    const bAgent = await mcpAs(budd, bobClaude.access);

    expect((await a.ok('whoami')).workspace).toBe('alice');
    expect((await bAgent.ok('whoami')).workspace).toBe('bob');
    await a.ok('inbox_count', { handle: 'assistant' });

    // Bob's agent can't see or reach Alice's.
    expect((await bAgent.ok('list_connections')).connections.map((c: any) => c.connection)).toEqual(
      ['claude'],
    );
    const sent = await bAgent.ok('send', {
      to: ['alice/claude/assistant'],
      from_handle: 'spy',
      body_md: 'hello',
    });
    expect(sent.results[0]).toMatchObject({ status: 'rejected', reason: 'cross_workspace' });
    expect((await a.ok('inbox_count', { handle: 'assistant' })).unread).toBe(0);

    // Bob's UI shows only Bob's workspace.
    const bobUi = await bb.go('/ui');
    expect(bobUi.body).toContain('<a class="name" href="/ui">bob</a>');
    expect(bobUi.body).not.toContain('<a class="name" href="/ui">alice</a>');
    expect(bobUi.body).toContain('bob@example.org');

    // Bob can't get an admin context for Alice's workspace.
    const aliceWs = (await accountOf(alice.email)).workspaces[0]?.id ?? '';
    const bobAccount = (await accountOf(bob.email)).account.id;
    await expect(budd.internals.gateway.adminForAccount(bobAccount, aliceWs)).rejects.toMatchObject(
      {
        code: 'not_a_member',
      },
    );

    // Workspace files are separate.
    const files = fs
      .readdirSync(path.join(budd.dataDir, 'workspaces'))
      .filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(2);
    await a.close();
    await bAgent.close();
  });

  it('a second account with the same email local part gets a suffixed workspace', async () => {
    await new Browser(budd).signIn(alice);
    const page = await new Browser(budd).signIn({ sub: 'other-alice', email: 'alice@example.net' });
    expect(page.body).toContain('<a class="name" href="/ui">alice-2</a>');
  });
});

describe('account > workspace > connection', () => {
  it('a connection stops working if its approving account loses access to the workspace', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b);
    expect((await rawMcp(budd, t.access)).status).toBe(200);
    const { account, workspaces } = await accountOf(alice.email);
    const db = new Database(path.join(budd.dataDir, 'control.db'));
    db.prepare('DELETE FROM memberships WHERE account_id = ? AND workspace_id = ?').run(
      account.id,
      workspaces[0]?.id,
    );
    db.close();
    const res = await rawMcp(budd, t.access);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no longer has access/);
    const refreshed = await token(budd, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: t.clientId,
    });
    expect(refreshed.body.error).toBe('invalid_grant');
  });
});

describe('the hosted UI', () => {
  it('requires sign-in for every page and the event stream', async () => {
    for (const p of ['/ui', '/ui/messages', '/ui/audit', '/ui/connections/x/policy']) {
      const res = await fetch(budd.url + p, { redirect: 'manual' });
      expect(res.status, p).toBe(302);
      expect(res.headers.get('location'), p).toMatch(/^\/login\?return=/);
    }
    expect((await fetch(`${budd.url}/ui/events`)).status).toBe(401);
  });

  it('signs out', async () => {
    const b = new Browser(budd);
    const ui = await b.signIn(alice);
    const out = await b.post('/logout', [['_csrf', field(ui.body, '_csrf')]]);
    expect(out.body).toContain('You have signed out');
    const again = await fetch(`${budd.url}/ui`, {
      redirect: 'manual',
      headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(again.status).toBe(302);
  });

  it('starts a fresh session at sign-in (no session fixation)', async () => {
    const b = new Browser(budd);
    const anonymous = await b.go('/login?return=/ui'); // a pre-login session cookie, if any
    expect(anonymous.status).toBe(200);
    const fixed = 'attacker-chosen-session-id';
    b.cookies.set('budd_session', fixed);
    await b.signIn(alice);
    expect(b.cookies.get('budd_session')).not.toBe(fixed);
  });

  it('refuses a form POST from another origin', async () => {
    const b = new Browser(budd);
    const ui = await b.signIn(alice);
    const res = await fetch(`${budd.url}/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: new URLSearchParams({ _csrf: field(ui.body, '_csrf') }).toString(),
    });
    expect(res.status).toBe(403);
  });
});

describe('the profile menu (hosted)', () => {
  it('shows the name and picture the provider gave, and lets only that picture’s origin through', async () => {
    const b = new Browser(budd);
    await b.signIn({
      sub: 'pic-sub',
      email: 'pat@example.com',
      name: 'Pat Example',
      picture: 'https://lh3.googleusercontent.com/a/pat=s96-c',
    });
    const page = await b.go('/ui');
    expect(page.body).toContain('src="https://lh3.googleusercontent.com/a/pat=s96-c"');
    expect(page.body).toContain('referrerpolicy="no-referrer"');
    expect(page.body).toMatch(/<span class="who">Pat Example<\/span>/);
    const policy = page.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("img-src 'self' https://lh3.googleusercontent.com;");
    expect(policy).toContain("script-src 'self';");
  });

  it('ignores a picture that isn’t https, and falls back to the email for a name', async () => {
    const b = new Browser(budd);
    await b.signIn({
      sub: 'plain-sub',
      email: 'plain@example.com',
      picture: 'http://tracker.example/p.png',
    });
    const page = await b.go('/ui');
    expect(page.body).not.toContain('tracker.example');
    expect(page.body).toMatch(/<span class="avatar initial" aria-hidden="true">P<\/span>/);
    expect(page.body).toMatch(/<span class="who">plain@example.com<\/span>/);
    expect(page.headers.get('content-security-policy')).toContain("img-src 'self';");
  });

  it('refuses a picture whose host could change the page’s policy', async () => {
    for (const [i, picture] of [
      'https://a;form-action/x.png',
      'https://a,b.example/x.png',
      'https://*/x.png',
    ].entries()) {
      const b = new Browser(budd);
      await b.signIn({ sub: `crafted-${String(i)}`, email: `c${String(i)}@example.com`, picture });
      const page = await b.go('/ui');
      expect(page.headers.get('content-security-policy'), picture).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(page.body, picture).toContain('class="avatar initial"');
    }
  });
});
