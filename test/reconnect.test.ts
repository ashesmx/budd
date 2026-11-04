import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirectUriAllowed } from '../src/auth/oauth.js';
import {
  authorizeUrl,
  Browser,
  CALLBACK,
  connectClient,
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
} from './helpers/hosted.js';

let budd: HostedBudd;
const alice = { sub: 'alice-sub', email: 'alice@example.com' };

beforeEach(async () => {
  budd = await startHostedBudd();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await budd.close();
});

const adminCtx = async () => {
  const { account, workspaces } = await budd.internals.storage.auth.signIn({
    issuer: budd.idp.issuer,
    subject: alice.sub,
    email: alice.email,
    slugBase: 'x',
    now: budd.clock.now,
  });
  return budd.internals.gateway.adminForAccount(account.id, workspaces[0]?.id ?? '');
};

/** Registers a client and opens its consent screen; returns the page and PKCE pair. */
async function openConsent(b: Browser, name = 'Claude') {
  const { body: client } = await register(budd, { client_name: name });
  const { verifier, challenge } = pkce();
  const page = await b.go(authorizeUrl(client.client_id, challenge));
  return { clientId: client.client_id as string, verifier, page };
}

async function approve(
  b: Browser,
  opened: Awaited<ReturnType<typeof openConsent>>,
  connection?: string,
) {
  const back = await b.post('/authorize', [
    ['_csrf', field(opened.page.body, '_csrf')],
    ['nonce', field(opened.page.body, 'nonce')],
    ['workspace', field(opened.page.body, 'workspace')],
    ...(connection === undefined ? [] : ([['connection', connection]] as [string, string][])),
    ['decision', 'approve'],
  ]);
  return new URL(back.url);
}

/** Answers the takeover page that follows choosing an existing connection. */
async function confirmTakeover(
  b: Browser,
  page: { body: string },
  choice: 'takeover' | 'new' | 'deny',
) {
  const back = await b.post('/authorize', [
    ['_csrf', field(page.body, '_csrf')],
    ['nonce', field(page.body, 'nonce')],
    ['workspace', field(page.body, 'workspace')],
    ['choice', choice],
  ]);
  return new URL(back.url);
}

/** Chooses an existing connection on the consent screen; returns the takeover page. */
async function chooseExisting(
  b: Browser,
  opened: Awaited<ReturnType<typeof openConsent>>,
  id: string,
) {
  return b.post('/authorize', [
    ['_csrf', field(opened.page.body, '_csrf')],
    ['nonce', field(opened.page.body, 'nonce')],
    ['workspace', field(opened.page.body, 'workspace')],
    ['connection', id],
    ['decision', 'approve'],
  ]);
}

const existingOption = (html: string, slug: string) => {
  const m = new RegExp(
    `name="connection"\\s+value="([^"]+)"\\s*/>\\s*Existing\\s*<code>${slug}</code>`,
  ).exec(html);
  if (!m?.[1]) throw new Error(`no option for ${slug}`);
  return m[1];
};

describe('a re-registered client can take over its old connection (ADR 0011)', () => {
  /** What the human does first in Budd: blocking signs out the app that held it. */
  const block = async (...slugs: string[]) => {
    const ctx = await adminCtx();
    for (const slug of slugs) await budd.admin.block(ctx, slug);
    budd.clock.now += 1000; // the app registers again after
    return ctx;
  };

  it('offers a connection only once the human has blocked it, defaulting to a new one', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    const active = (await openConsent(b, 'Claude')).page.body.replace(/\s+/g, ' ');
    expect(active).not.toContain('Which connection should it use?');
    expect(active).toContain(
      'To use your existing connection <code>claude</code> instead, <a href="/ui/connections/claude">block it in Budd</a> (this signs out the app using it), then, within the hour, start connecting again from the app itself',
    );
    await block('claude');
    const { page } = await openConsent(b, 'Claude');
    expect(page.body).toContain('Which connection should it use?');
    expect(page.body).toMatch(/name="connection" value="new" checked/);
    existingOption(page.body, 'claude');
  });

  it('attaches the new client and unblocks the connection, keeping its label', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const old = await connectClient(budd, b, 'Claude');
    const ctx = await block('claude');
    await budd.admin.relabel(ctx, 'claude', 'my laptop');
    expect((await rawMcp(budd, old.access)).status).toBe(401); // blocking signed it out

    const opened = await openConsent(b, 'Claude');
    const takeover = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
    const back = await confirmTakeover(b, takeover, 'takeover');
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: CALLBACK,
      code_verifier: opened.verifier,
      client_id: opened.clientId,
    });
    expect(t.status).toBe(200);
    const agent = await mcpAs(budd, t.body.access_token);
    expect((await agent.ok('whoami')).connection).toBe('claude');
    await agent.close();

    const overview = await budd.admin.overview(ctx);
    expect(overview.map((c) => [c.slug, c.status, c.label])).toEqual([
      ['claude', 'active', 'my laptop'],
    ]);
    const events = (await budd.admin.audit(ctx, 100)).map((e) => e.event);
    expect(events).toContain('connection_unblocked');
    expect(events.indexOf('connection_attached')).toBeLessThan(
      events.indexOf('connection_unblocked'),
    ); // newest first: unblocked, then attached
    const attached = (await budd.admin.audit(ctx, 100)).find(
      (e) => e.event === 'connection_attached',
    );
    expect(attached?.detail).toMatchObject({ connection: 'claude', client_id: opened.clientId });
  });

  it('asks once more before a takeover, naming the connection and that it unblocks it', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await block('claude');
    const opened = await openConsent(b, 'Claude');
    const page = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
    expect(page.status).toBe(200);
    const text = page.body.replace(/\s+/g, ' ');
    expect(text).toContain('Give <code>claude</code> to <q>Claude</q>?');
    expect(text).toContain(
      '<code>claude</code> is blocked: giving it to <q>Claude</q> unblocks it',
    );
    // Enter and the focus deny: Deny is the form's first button. Handing over is `danger`.
    expect(text.match(/<button[^>]*>/)?.[0]).toBe(
      '<button class="later" name="choice" value="deny" autofocus>',
    );
    expect(text).toContain(
      'class="btn primary" name="choice" value="new">Give it a new connection',
    );
    expect(text).toContain(
      'class="btn danger" name="choice" value="takeover">Give claude to Claude</button>',
    );
  });

  it('on the takeover page, a missing or unknown choice denies', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await block('claude');
    for (const choice of [undefined, 'yes']) {
      const opened = await openConsent(b, 'Claude');
      const page = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
      const back = await b.post('/authorize', [
        ['_csrf', field(page.body, '_csrf')],
        ['nonce', field(page.body, 'nonce')],
        ['workspace', field(page.body, 'workspace')],
        ...(choice === undefined ? [] : ([['choice', choice]] as [string, string][])),
      ]);
      expect(new URL(back.url).searchParams.get('error'), String(choice)).toBe('access_denied');
    }
  });

  it('on the takeover page, a new connection or Deny leaves the old one blocked', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    const ctx = await block('claude');
    for (const [choice, expected] of [
      ['new', 'claude-2'],
      ['deny', undefined],
    ] as const) {
      const opened = await openConsent(b, 'Claude');
      const page = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
      const back = await confirmTakeover(b, page, choice);
      if (expected === undefined) {
        expect(back.searchParams.get('error')).toBe('access_denied');
        continue;
      }
      const t = await token(budd, {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: CALLBACK,
        code_verifier: opened.verifier,
        client_id: opened.clientId,
      });
      const agent = await mcpAs(budd, t.body.access_token);
      expect((await agent.ok('whoami')).connection).toBe(expected);
      await agent.close();
    }
    const claude = (await budd.admin.overview(ctx)).find((c) => c.slug === 'claude');
    expect(claude?.status).toBe('blocked');
  });

  it('the takeover page confirms only the connection chosen, once, and not one unblocked since', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await connectClient(budd, b, 'Grok Build');
    const ctx = await block('claude', 'grok-build');

    // A different connection id in the confirming POST is ignored.
    const opened = await openConsent(b, 'Claude');
    const grokId = existingOption(opened.page.body, 'grok-build');
    const page = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
    const forged = await b.post('/authorize', [
      ['_csrf', field(page.body, '_csrf')],
      ['nonce', field(page.body, 'nonce')],
      ['workspace', field(page.body, 'workspace')],
      ['connection', grokId],
      ['choice', 'takeover'],
    ]);
    const code = new URL(forged.url).searchParams.get('code') ?? '';
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: opened.verifier,
      client_id: opened.clientId,
    });
    const agent = await mcpAs(budd, t.body.access_token);
    expect((await agent.ok('whoami')).connection).toBe('claude');
    await agent.close();

    // The page's nonce works once.
    const again = await b.post('/authorize', [
      ['_csrf', field(page.body, '_csrf')],
      ['nonce', field(page.body, 'nonce')],
      ['workspace', field(page.body, 'workspace')],
      ['choice', 'takeover'],
    ]);
    expect(again.status).toBe(400);

    // Unblocked between the two steps: no longer one the human set aside.
    const next = await openConsent(b, 'Grok Build');
    const grokPage = await chooseExisting(b, next, existingOption(next.page.body, 'grok-build'));
    await budd.admin.unblock(ctx, 'grok-build', { confirmed: true });
    const refused = await b.post('/authorize', [
      ['_csrf', field(grokPage.body, '_csrf')],
      ['nonce', field(grokPage.body, 'nonce')],
      ['workspace', field(grokPage.body, 'workspace')],
      ['choice', 'takeover'],
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('can no longer be chosen');
  });

  it('still creates a new connection by default', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await block('claude');
    const opened = await openConsent(b, 'Claude');
    const back = await approve(b, opened, 'new');
    const t = await token(budd, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: CALLBACK,
      code_verifier: opened.verifier,
      client_id: opened.clientId,
    });
    const agent = await mcpAs(budd, t.body.access_token);
    expect((await agent.ok('whoami')).connection).toBe('claude-2');
    await agent.close();
  });

  it('refuses a connection it did not offer, or one unblocked since', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    const ctx = await block('claude');

    const forged = await openConsent(b, 'Claude');
    const r1 = await b.post('/authorize', [
      ['_csrf', field(forged.page.body, '_csrf')],
      ['nonce', field(forged.page.body, 'nonce')],
      ['workspace', field(forged.page.body, 'workspace')],
      ['connection', '01JZZZZZZZZZZZZZZZZZZZZZZZ'],
      ['decision', 'approve'],
    ]);
    expect(r1.status).toBe(400);

    const opened = await openConsent(b, 'Claude');
    const id = existingOption(opened.page.body, 'claude');
    await budd.admin.unblock(ctx, 'claude', { confirmed: true });
    const r2 = await b.post('/authorize', [
      ['_csrf', field(opened.page.body, '_csrf')],
      ['nonce', field(opened.page.body, 'nonce')],
      ['workspace', field(opened.page.body, 'workspace')],
      ['connection', id],
      ['decision', 'approve'],
    ]);
    expect(r2.status).toBe(400);
    expect(r2.body).toContain('can no longer be chosen');
  });

  it('offers a connection only to a client that returns to the same place', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude'); // returns to the loopback CALLBACK
    await block('claude');
    // Anyone can register a client named "Claude"; one that returns elsewhere isn't offered it.
    const phish = 'https://attacker.example/callback';
    const { body: lookalike } = await register(budd, {
      client_name: 'Claude',
      redirect_uris: [phish],
    });
    const page = await b.go(
      authorizeUrl(lookalike.client_id, pkce().challenge, { redirect_uri: phish }),
    );
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('Which connection should it use?');
    expect(page.body.replace(/\s+/g, ' ')).toContain(
      'that connection belongs to an app that returns to a different address',
    );
    // A native app back on another loopback port is the same place.
    const { body: native } = await register(budd, {
      redirect_uris: ['http://localhost:4567/callback'],
    });
    const again = await b.go(
      authorizeUrl(native.client_id, pkce().challenge, {
        redirect_uri: 'http://localhost:4567/callback',
      }),
    );
    existingOption(again.body, 'claude');
  });

  it('never offers it to a link made before the block, or after the hour', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    // Someone else's app registered first and sent its link; following the
    // advice and blocking doesn't make that link able to take it.
    const { body: early } = await register(budd, { client_name: 'Claude' });
    await block('claude');
    const fromLink = await b.go(authorizeUrl(early.client_id, pkce().challenge));
    expect(fromLink.body).not.toContain('Which connection should it use?');
    // An app registering after the block can, but only within the hour.
    budd.clock.now += 60 * 60_000;
    const late = await openConsent(b, 'Claude');
    expect(late.page.body).not.toContain('Which connection should it use?');
  });

  it('removes the old app’s approval when another takes the connection over', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const old = await connectClient(budd, b, 'Claude');
    await block('claude');
    const opened = await openConsent(b, 'Claude');
    const page = await chooseExisting(b, opened, existingOption(opened.page.body, 'claude'));
    await confirmTakeover(b, page, 'takeover');
    // The old client asking again isn't simply let back in: it's a new app to Budd.
    const again = await b.go(authorizeUrl(old.clientId, pkce().challenge));
    expect(again.body).not.toContain('It will use its existing connection');
    const ctx = await adminCtx();
    const attached = (await budd.admin.audit(ctx, 100)).find(
      (e) => e.event === 'connection_attached',
    );
    expect(attached?.detail).toMatchObject({ grants_removed: 1 });
  });

  it('does not offer active or archived connections', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await connectClient(budd, b, 'Grok Build');
    await budd.admin.archive(await adminCtx(), 'grok-build');
    const { page } = await openConsent(b, 'Claude');
    expect(page.body).not.toContain('Which connection should it use?');
  });
});

describe('archived connections in hosted mode', () => {
  it('revokes tokens on archive and refuses re-authorization until restored and unblocked', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b, 'Claude');
    const ctx = await adminCtx();
    await budd.admin.archive(ctx, 'claude');
    expect((await rawMcp(budd, t.access)).status).toBe(401);

    const { challenge } = pkce();
    const page = await b.go(authorizeUrl(t.clientId, challenge));
    const back = await decide(b, page, 'approve');
    expect(back.status).toBe(403);
    expect(back.body).toContain('Its connection is archived.');
    expect(back.body.replace(/\s+/g, ' ')).toContain(
      'restore <code>claude</code>, then unblock it, on its page in Budd',
    );
    expect((await b.go('/ui/connections/claude')).status).toBe(200); // the page it links to
    const url = new URL(returnLink(back.body));
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toMatch(/archived/);

    await budd.admin.restore(ctx, 'claude');
    await budd.admin.unblock(ctx, 'claude', { confirmed: true });
    const again = await b.go(authorizeUrl(t.clientId, challenge));
    expect(again.status).toBe(200);
  });
});

describe('live tokens in the overview', () => {
  it('shows whether any app still holds a usable token', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b, 'Claude');
    const ctx = await adminCtx();
    expect((await budd.admin.overview(ctx))[0]?.hasLiveTokens).toBe(true);

    const res = await fetch(`${budd.url}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh, client_id: t.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    const [c] = await budd.admin.overview(ctx);
    expect(c?.status).toBe('active');
    expect(c?.hasLiveTokens).toBe(false);
    expect((await b.go('/ui?view=table')).body).toContain('No app signed in');
  });
});

describe('loopback redirect ports (RFC 8252 §7.3)', () => {
  const registered = ['http://127.0.0.1:58246/callback', 'https://app.example/cb'];

  it.each([
    ['the registered URI', 'http://127.0.0.1:58246/callback', true],
    ['another loopback port', 'http://127.0.0.1:61000/callback', true],
    ['no port', 'http://127.0.0.1/callback', true],
    ['a different path', 'http://127.0.0.1:61000/other', false],
    ['a different loopback host', 'http://localhost:61000/callback', false],
    ['an https port change', 'https://app.example:8443/cb', false],
    ['an added query', 'http://127.0.0.1:61000/callback?x=1', false],
  ])('%s', (_, uri, ok) => {
    expect(redirectUriAllowed(registered, uri)).toBe(ok);
  });

  it('lets a native client come back on a new port', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { body: client } = await register(budd);
    const page = await b.go(
      authorizeUrl(client.client_id, pkce().challenge, {
        redirect_uri: 'http://127.0.0.1:2/callback',
      }),
    );
    expect(page.status).toBe(200);
    const back = await decide(b, page, 'approve');
    expect(continueTarget(back.body).refresh).toMatch(
      /^http:\/\/127\.0\.0\.1:2\/callback\?code=budd_code_/,
    );
  });
});

describe('auth events reach the log (metadata only)', () => {
  it('logs registration, authorization, token issue and failures, never a credential', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    vi.spyOn(console, 'error').mockImplementation((l: string) => lines.push(l));
    const b = new Browser(budd);
    await b.signIn(alice);
    const t = await connectClient(budd, b, 'Claude');
    await rawMcp(budd, 'budd_at_nope');
    await token(budd, {
      grant_type: 'refresh_token',
      refresh_token: 'budd_rt_nope',
      client_id: t.clientId,
    });

    const msgs = lines.map((l) => (JSON.parse(l) as { msg: string }).msg);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'signed in',
        'client registered',
        'app authorized',
        'token issued',
        'mcp access token rejected',
        'token request refused',
      ]),
    );
    const all = lines.join('\n');
    for (const secret of [t.access, t.refresh, 'budd_code_', 'budd_cs_']) {
      expect(all).not.toContain(secret);
    }
  });
});
