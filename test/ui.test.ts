import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEventType } from '../src/domain/types.js';
import { hashPassword } from '../src/auth/password.js';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

beforeEach(async () => {
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  const auth = budd.internals.storage.auth;
  await auth.setLocalLogin({
    accountId: (await auth.getLocalAccountId()) ?? '',
    username: USERNAME,
    passwordHash: await passwordHash,
    now: budd.clock.now,
  });
});

afterEach(async () => {
  await budd.close();
});

/** A minimal browser: keeps the session cookie and reads CSRF tokens and nonces from pages. */
class Browser {
  cookie: string | undefined;

  async get(path: string) {
    const res = await fetch(budd.url + path, {
      headers: this.cookie ? { cookie: this.cookie } : {},
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { res, body: await res.text() };
  }

  async post(path: string, fields: [string, string][], headers: Record<string, string> = {}) {
    const res = await fetch(budd.url + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(this.cookie && { cookie: this.cookie }),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { res, body: await res.text() };
  }

  /** Follows a POST's redirect, as a browser does. */
  async follow(r: { res: Response }) {
    const to = r.res.headers.get('location');
    if (!to) throw new Error(`no redirect: ${String(r.res.status)}`);
    return this.get(to);
  }

  async csrf(path = '/ui') {
    return field((await this.get(path)).body, '_csrf');
  }

  /** Signs in with the local login (ADR 0010). */
  async login() {
    const page = await this.get('/login');
    return this.post('/login', [
      ['_csrf', field(page.body, '_csrf')],
      ['username', USERNAME],
      ['password', PASSWORD],
    ]);
  }
}

const USERNAME = 'alice';
const PASSWORD = 'correct horse battery';
const passwordHash = hashPassword(PASSWORD);

/** A browser that has signed in to the local UI. */
async function signedIn(): Promise<Browser> {
  const b = new Browser();
  const r = await b.login();
  if (r.res.status !== 303) throw new Error(`login failed: ${String(r.res.status)}`);
  return b;
}

const field = (html: string, name: string) => {
  const m = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!m?.[1]) throw new Error(`no ${name} field`);
  return m[1];
};

/** A connection's id, for filtering through Admin as the UI does. */
const idOf = async (slug: string) =>
  (await budd.admin.connections(budd.adminCtx)).find((c) => c.slug === slug)?.id;

const grokPolicy = async () =>
  (await grok.ok('policy_get')) as { mode: string; allowed_connections: string[] };

describe('pages', () => {
  it('ignores flash keys that aren’t its own (no 500 from ?done=__proto__)', async () => {
    const b = await signedIn();
    for (const q of ['done=__proto__', 'error=constructor', 'done=toString']) {
      const { res } = await b.get(`/ui?${q}`);
      expect(res.status, q).toBe(200);
    }
  });

  it('redirects / to the UI, which needs signing in; signing in sets a strict, HttpOnly cookie', async () => {
    const root = await fetch(budd.url + '/', { redirect: 'manual' });
    expect(root.headers.get('location')).toBe('/ui');
    const anonymous = await new Browser().get('/ui');
    expect(anonymous.res.status).toBe(302);
    expect(anonymous.res.headers.get('location')).toBe('/login?return=%2Fui');
    const { res } = await new Browser().login();
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^budd_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('sends security headers that forbid framing and inline script', async () => {
    const { res } = await (await signedIn()).get('/ui');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    // Regression: with "no-referrer", real browsers send `Origin: null` on form
    // POSTs and every UI form was refused (found with headless Chrome).
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('shows the logo in the header, in the theme’s colours, with the favicon (a standalone page too)', async () => {
    for (const { body } of [
      await (await signedIn()).get('/ui'),
      await new Browser().get('/login'),
    ]) {
      const page = body.replace(/\s+/g, ' ');
      expect(page).toContain('<link rel="icon" href="/ui/logo/favicon.svg" type="image/svg+xml"');
      // Fingerprinted, so no cache (or proxy rewriting Cache-Control) serves an old one after an upgrade.
      expect(page).toMatch(/<link rel="stylesheet" href="\/ui\/app\.css\?v=[\w-]{12}"/);
      expect(page).toMatch(/<script src="\/ui\/app\.js\?v=[\w-]{12}" defer>/);
      expect(page).toMatch(/class="brand"[^>]*>\s?<picture/);
      expect(page).toContain(
        '<source srcset="/ui/logo/budd-wordmark-dark.svg" media="(prefers-color-scheme: dark)"',
      );
      expect(page).toMatch(/<img src="\/ui\/logo\/budd-wordmark-light.svg" alt="Budd"/);
    }
  });

  it('serves every logo file from its own origin, under the same headers, and nothing else under /ui/logo', async () => {
    for (const name of [
      'budd-wordmark-light.svg',
      'budd-wordmark-dark.svg',
      'budd-mark-light.svg',
      'budd-mark-dark.svg',
      'budd-mark-small-light.svg',
      'budd-mark-small-dark.svg',
      'favicon.svg',
    ]) {
      const res = await fetch(`${budd.url}/ui/logo/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type'), name).toBe('image/svg+xml');
      expect(res.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(await res.text(), name).toMatch(/^<svg [^>]*aria-label="Budd"/);
    }
    for (const path of ['README.md', 'missing.svg', '..%2Fassets.ts', '%2e%2e/logo.ts']) {
      expect((await fetch(`${budd.url}/ui/logo/${path}`)).status, path).toBe(404);
    }
  });

  it('local mode offers no API-key connections', async () => {
    const b = await signedIn();
    expect((await b.get('/ui?view=table')).body).not.toContain('API key');
    const page = await b.get('/ui/new');
    expect(page.body).toContain('An app you sign in with');
    expect(page.body).not.toContain('An agent with an API key');
    const old = await b.get('/ui/add-agent');
    expect(old.res.headers.get('location')).toBe('/ui/new');
  });

  it('About Budd shows the version', async () => {
    const { body } = await (await signedIn()).get('/ui/settings');
    expect(body).toContain('About Budd');
    expect(body).toMatch(/<dt>Version<\/dt>\s*<dd><code>\d+\.\d+\.\d+[^<]*<\/code><\/dd>/);
  });

  it('shows connections, live queues with unread counts, and policies', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    const { body } = await (await signedIn()).get('/ui?view=table');
    // Each connection lists its handles (its mailboxes), with a badge only when unread.
    const row = (slug: string) =>
      /<tr id="c-[^"]+">[\s\S]*?<\/tr>/g.exec(
        body.slice(body.indexOf(`id="c-${slug}"`) - 8),
      )?.[0] ?? '';
    expect(row('grok-build')).toMatch(/<code class="handle">researcher<\/code/);
    expect(row('grok-build')).toMatch(/data-unread="grok-build\/researcher"\s*>\s*1/);
    expect(row('claude-desktop')).toMatch(/<code class="handle">chief-of-staff<\/code/);
    expect(row('claude-desktop')).not.toContain('data-unread');
    expect(body).not.toContain('<h2>Mailboxes</h2>');
    expect(body).toContain('id="c-grok-build"');
    expect(body).not.toContain('id="c-budd"');
  });

  it('says handles are unverified beside every list of mailboxes, and that messages are untrusted', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    const b = await signedIn();
    for (const path of ['/ui?view=table', '/ui/connections/grok-build']) {
      const { body } = await b.get(path);
      expect(body, path).toMatch(
        /<span class="info" tabindex="0" aria-describedby="mailboxes-note"/,
      );
      expect(body, path).toContain('Handles are unverified.');
    }
    const mailbox = await b.get('/ui/connections/grok-build/mailboxes/researcher');
    expect(mailbox.body).toContain('aria-describedby="mailbox-note"');
    for (const path of ['/ui/messages', '/ui/messages?view=list']) {
      const { body } = await b.get(path);
      expect(body, path).toContain('class="handle"');
      expect(body.replace(/\s+/g, ' '), path).toContain('treat what they say as untrusted');
    }
    // No standing footer: each warning sits where it applies.
    expect((await b.get('/ui')).body).not.toContain('app-footer');
    const audit = (await b.get('/ui/audit')).body;
    expect(audit).toContain('handles in details are self-declared and unverified');
  });

  it('shows message history with delivery states, escaping message content', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      subject: '<img src=x onerror=alert(1)>',
      body_md: '<script>alert("pwned")</script>',
      payload: { evil: '</pre><script>x()</script>' },
    });
    const b = await signedIn();
    for (const path of ['/ui/messages', '/ui/messages?view=list']) {
      const { body } = await b.get(path);
      expect(body, path).not.toContain('<img src=x');
      expect(body, path).not.toContain('<script>alert');
      expect(body, path).not.toContain('<script>x()');
      expect(body, path).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
      // Unread: a dot, the accent bar, and the words.
      expect(body, path).toMatch(/<article class="msg is-unread"/);
      expect(body, path).toContain('<span class="dot unread" aria-hidden="true"></span>');
      expect(body, path).toContain('Not read yet');
      // The payload opens in place, and the sender's chip opens its mailbox.
      expect(body, path).toMatch(/aria-label="Show its payload"/);
      expect(body, path).toContain(
        'href="/ui/connections/claude-desktop/mailboxes/chief-of-staff"',
      );
    }
    await grok.ok('inbox', { handle: 'researcher' });
    const { body } = await b.get('/ui/messages?view=list');
    expect(body).toMatch(/Read\s*<time/);
    expect(body).not.toContain('is-unread');
  });

  it('shows the audit log', async () => {
    const { body } = await (await signedIn()).get('/ui/audit');
    expect(body).toContain('connection_registered');
    expect(body).toContain('handle_first_seen');
  });

  it('404s for an unknown connection', async () => {
    const { res } = await (await signedIn()).get('/ui/connections/nobody');
    expect(res.status).toBe(404);
  });

  it('answers an unknown address with a page that leads back, under the usual headers', async () => {
    for (const path of ['/nonsense', '/ui/nonsense']) {
      const res = await fetch(`${budd.url}${path}`, { headers: { accept: 'text/html' } });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'none'");
      const body = await res.text();
      expect(body, path).toContain('Page not found');
      expect(body, path).toContain('href="/ui"');
    }
  });

  it('answers a machine at an unknown address with JSON', async () => {
    const res = await fetch(`${budd.url}/.well-known/nonsense`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('admin actions', () => {
  it('blocks and unblocks a connection', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const blocked = await b.post('/ui/connections/grok-build/block', [['_csrf', csrf]]);
    expect(blocked.res.status).toBe(303);
    expect(blocked.res.headers.get('location')).toMatch(/done=blocked/);
    await expect(grok.call('whoami')).rejects.toThrow(/blocked/);
    expect((await b.get('/ui?view=table')).body).toMatch(/class="status blocked">Blocked</);

    // The confirm step is a page of its own after the POST, so reloading it is safe.
    const asked = await b.post('/ui/connections/grok-build/unblock', [['_csrf', csrf]]);
    expect(asked.res.status).toBe(303);
    expect(asked.res.headers.get('location')).toMatch(/^\/ui\/connections\/grok-build\?confirm=/);
    const dialog = await b.follow(asked);
    expect(dialog.body).toMatch(/Unblock <code>grok-build<\/code>\?/);
    expect((await b.follow(asked)).body).toContain('data-confirm'); // a reload shows it again
    await b.post('/ui/connections/grok-build/unblock/confirm', [
      ['_csrf', csrf],
      ['nonce', field(dialog.body, 'nonce')],
    ]);
    expect((await grok.ok('whoami')).connection).toBe('grok-build');
  });

  it('archives a connection: blocked, hidden, and restorable', async () => {
    await budd.setPolicy('grok-build', 'all');
    const b = await signedIn();
    const csrf = await b.csrf();
    const archived = await b.post('/ui/connections/grok-build/archive', [['_csrf', csrf]]);
    expect(archived.res.headers.get('location')).toMatch(
      /\/ui\/connections\/grok-build\?done=archived/,
    );
    await expect(grok.call('whoami')).rejects.toThrow(/archived.*restore/i);

    // Hidden from the table and the map; the Status filter finds it; its page is read-only.
    expect((await b.get('/ui?view=table')).body).not.toContain('id="c-grok-build"');
    expect((await b.get('/ui')).body).not.toContain('data-node="grok-build"');
    expect((await b.get('/ui?view=table&status=archived')).body).toContain('id="c-grok-build"');
    const page = (await b.get('/ui/connections/grok-build')).body;
    expect(page).not.toContain('action="/ui/connections/grok-build/block"');
    expect(page).not.toContain('action="/ui/connections/grok-build/policy"');
    expect(page).toContain('action="/ui/connections/grok-build/restore"');
    expect(page).toContain('class="frozen"');
    // Agents no longer see it, and can't message it.
    const listed = await claude.ok('list_connections');
    expect(listed.connections.map((c: { connection: string }) => c.connection)).not.toContain(
      'grok-build',
    );
    const sent = await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    expect(sent.results[0]).toMatchObject({ status: 'rejected', reason: 'blocked' });

    // Unblocking an archived connection is refused: restore it first.
    const dialog = await b.follow(
      await b.post('/ui/connections/grok-build/unblock', [['_csrf', csrf]]),
    );
    const refused = await b.post('/ui/connections/grok-build/unblock/confirm', [
      ['_csrf', csrf],
      ['nonce', field(dialog.body, 'nonce')],
    ]);
    expect(refused.res.headers.get('location')).toMatch(/error=archived/);

    const restored = await b.post('/ui/connections/grok-build/restore', [['_csrf', csrf]]);
    expect(restored.res.headers.get('location')).toMatch(/done=restored/);
    expect((await b.get('/ui?view=table')).body).toMatch(/class="status blocked">Blocked</);
    await expect(grok.call('whoami')).rejects.toThrow(/blocked/);

    const events = (await budd.audit()).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['connection_archived', 'connection_restored', 'connection_blocked']),
    );
  });

  it('unblocking needs the confirm step too', async () => {
    await budd.admin.block(budd.adminCtx, 'grok-build');
    const b = await signedIn();
    const csrf = await b.csrf();
    await b.post('/ui/connections/grok-build/unblock', [['_csrf', csrf]]);
    for (const nonce of ['', 'guess']) {
      const r = await b.post('/ui/connections/grok-build/unblock/confirm', [
        ['_csrf', csrf],
        ['nonce', nonce],
      ]);
      expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    }
    // A nonce issued for a policy change can't confirm an unblock, or vice versa.
    const widen = await b.follow(
      await b.post('/ui/connections/grok-build/policy', [
        ['_csrf', csrf],
        ['mode', 'all'],
      ]),
    );
    const r = await b.post('/ui/connections/grok-build/unblock/confirm', [
      ['_csrf', csrf],
      ['nonce', field(widen.body, 'nonce')],
    ]);
    expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    await expect(grok.call('whoami')).rejects.toThrow(/blocked/);
    await expect(budd.admin.unblock(budd.adminCtx, 'grok-build')).rejects.toMatchObject({
      code: 'confirmation_required',
    });
  });

  it('relabels a connection, escaping the label', async () => {
    const b = await signedIn();
    await b.post('/ui/connections/grok-build/label', [
      ['_csrf', await b.csrf()],
      ['label', '<b>Grok</b> laptop'],
    ]);
    const { body } = await b.get('/ui?view=table');
    expect(body).toContain('&lt;b&gt;Grok&lt;/b&gt; laptop');
    const list = await claude.ok('list_connections');
    expect(list.connections.find((c: any) => c.connection === 'grok-build').label).toBe(
      '<b>Grok</b> laptop',
    );
  });

  it('applies a narrowing policy change at once', async () => {
    await budd.setPolicy('grok-build', 'all');
    const b = await signedIn();
    const r = await b.post('/ui/connections/grok-build/policy', [
      ['_csrf', await b.csrf()],
      ['mode', 'allowlist'],
    ]);
    expect(r.res.headers.get('location')).toMatch(/done=policy_saved/);
    expect(await grokPolicy()).toMatchObject({ mode: 'allowlist', allowed_connections: [] });
  });

  describe('CSRF and origin protection', () => {
    it('refuses a POST without the CSRF token', async () => {
      const b = await signedIn();
      await b.get('/ui');
      const r = await b.post('/ui/connections/grok-build/block', []);
      expect(r.res.status).toBe(403);
      expect((await grok.ok('whoami')).connection).toBe('grok-build');
    });

    it('refuses a CSRF token from a different session', async () => {
      const alice = await signedIn();
      const mallory = await signedIn();
      const token = await alice.csrf();
      await mallory.get('/ui');
      expect(
        (await mallory.post('/ui/connections/grok-build/block', [['_csrf', token]])).res.status,
      ).toBe(403);
    });

    it('refuses a POST without the session cookie', async () => {
      const token = await (await signedIn()).csrf();
      const r = await new Browser().post('/ui/connections/grok-build/block', [['_csrf', token]]);
      expect(r.res.status).toBe(403);
    });

    it('refuses a POST from another origin, even another local port', async () => {
      const b = await signedIn();
      const csrf = await b.csrf();
      for (const origin of [
        'http://localhost:3000',
        'http://127.0.0.1:1',
        'https://evil.example',
      ]) {
        const r = await b.post('/ui/connections/grok-build/block', [['_csrf', csrf]], { origin });
        expect(r.res.status, origin).toBe(403);
      }
      expect((await grok.ok('whoami')).connection).toBe('grok-build');
    });
  });
});

describe('widening a policy needs the two-step confirmation (§9)', () => {
  const widen = async (b: Browser, csrf: string, allowed = 'claude-desktop') =>
    b.follow(
      await b.post('/ui/connections/grok-build/policy', [
        ['_csrf', csrf],
        ['mode', 'allowlist'],
        ['allowed', allowed],
      ]),
    );
  const confirm = (b: Browser, csrf: string, nonce: string, slug = 'grok-build') =>
    b.post(`/ui/connections/${slug}/policy/confirm`, [
      ['_csrf', csrf],
      ['nonce', nonce],
    ]);

  it('step 1 alone changes nothing: it only shows a confirm dialog', async () => {
    const b = await signedIn();
    const r = await widen(b, await b.csrf());
    expect(r.res.status).toBe(200);
    expect(r.body).toContain('data-confirm');
    // Another session can't see the dialog, or the nonce, by following the same link.
    const other = await signedIn();
    const confirmUrl = /action="[^"]*"/.exec(r.body)
      ? `/ui/connections/grok-build?confirm=${field(r.body, 'nonce')}`
      : '';
    expect((await other.get(confirmUrl)).body).not.toContain('data-confirm');
    expect(r.body).toMatch(/This lets\s+<code>claude-desktop<\/code>\s+send messages/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: [] });
  });

  it('a single raw POST cannot widen, whichever endpoint it targets', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    await b.post('/ui/connections/grok-build/policy', [
      ['_csrf', csrf],
      ['mode', 'all'],
      ['confirmed', 'true'],
      ['nonce', 'x'],
    ]);
    for (const nonce of ['', 'guess', 'true']) {
      const r = await confirm(b, csrf, nonce);
      expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    }
    expect(await grokPolicy()).toMatchObject({ mode: 'allowlist', allowed_connections: [] });
  });

  it('confirming with the nonce applies the change and audits it', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const nonce = field((await widen(b, csrf)).body, 'nonce');
    const r = await confirm(b, csrf, nonce);
    expect(r.res.headers.get('location')).toMatch(/done=widened/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: ['claude-desktop'] });
    const event = (await budd.audit()).filter((e) => e.event === 'policy_widened').at(-1);
    expect(event).toMatchObject({ actor: 'human', detail: { confirmed: true } });
    const sent = await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    expect(sent.results[0].status).toBe('delivered');
  });

  it('a nonce works once only', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const nonce = field((await widen(b, csrf)).body, 'nonce');
    await confirm(b, csrf, nonce);
    await budd.setPolicy('grok-build', 'allowlist', []);
    const again = await confirm(b, csrf, nonce);
    expect(again.res.headers.get('location')).toMatch(/error=confirm_failed/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: [] });
  });

  it('a nonce is bound to the session that started the change', async () => {
    const alice = await signedIn();
    const nonce = field((await widen(alice, await alice.csrf())).body, 'nonce');
    const mallory = await signedIn();
    const r = await confirm(mallory, await mallory.csrf(), nonce);
    expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: [] });
  });

  it('a nonce is bound to its connection', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const nonce = field((await widen(b, csrf)).body, 'nonce');
    const r = await confirm(b, csrf, nonce, 'claude-desktop');
    expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    expect((await claude.ok('policy_get')).allowed_connections).toEqual([]);
  });

  it('a nonce expires after 5 minutes', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const nonce = field((await widen(b, csrf)).body, 'nonce');
    budd.clock.now += 5 * 60_000;
    const r = await confirm(b, csrf, nonce);
    expect(r.res.headers.get('location')).toMatch(/error=confirm_failed/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: [] });
  });

  it('refuses to confirm if the policy changed in between', async () => {
    await claude.close();
    const code = await budd.connect('claude-code');
    await code.ok('whoami');
    const b = await signedIn();
    const csrf = await b.csrf();
    const nonce = field((await widen(b, csrf)).body, 'nonce');
    await budd.setPolicy('grok-build', 'allowlist', ['claude-code']);
    const r = await confirm(b, csrf, nonce);
    expect(r.res.headers.get('location')).toMatch(/error=policy_changed/);
    expect(await grokPolicy()).toMatchObject({ allowed_connections: ['claude-code'] });
  });

  it('switching to "all" also needs confirmation', async () => {
    const b = await signedIn();
    const csrf = await b.csrf();
    const r = await b.follow(
      await b.post('/ui/connections/grok-build/policy', [
        ['_csrf', csrf],
        ['mode', 'all'],
      ]),
    );
    expect(r.body).toMatch(/every connection in this workspace/);
    expect(await grokPolicy()).toMatchObject({ mode: 'allowlist' });
    await confirm(b, csrf, field(r.body, 'nonce'));
    expect(await grokPolicy()).toMatchObject({ mode: 'all' });
  });
});

describe('live updates', () => {
  it('streams a change event when a message is sent', async () => {
    expect((await fetch(`${budd.url}/ui/events`)).status).toBe(401); // needs signing in
    const b = await signedIn();
    const res = await fetch(`${budd.url}/ui/events`, { headers: { cookie: b.cookie ?? '' } });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no'); // nginx must not buffer it
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (until: RegExp) => {
      while (!until.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await read(/event: ready/);
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    await read(/"kind":"send"/);
    expect(text).toMatch(/event: change\ndata: \{"kind":"send"\}/);
    expect(text).not.toContain('chief-of-staff'); // events carry no content, just "something changed"
    await reader.cancel();
  });

  it('ends the stream when its session signs out', async () => {
    const b = await signedIn();
    const res = await fetch(`${budd.url}/ui/events`, { headers: { cookie: b.cookie ?? '' } });
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    await reader.read(); // "ready"
    expect((await b.post('/logout', [['_csrf', await b.csrf()]])).res.status).toBe(200);
    let done = false;
    while (!done) ({ done } = await reader.read());
  });

  it('only streams events from its own workspace', async () => {
    const seen: string[] = [];
    const other = '01JA0000000000000000000000';
    const unsubscribe = budd.events.subscribe(other, (e) => seen.push(e.kind));
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    unsubscribe();
    expect(seen).toEqual([]);
  });
});

describe('DNS-rebinding protection covers the UI', () => {
  it('refuses a non-loopback Origin on UI pages', async () => {
    const res = await fetch(`${budd.url}/ui`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('finding messages', () => {
  const send = (body_md: string, extra: Record<string, unknown> = {}) =>
    claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md,
      ...extra,
    });

  beforeEach(async () => {
    await budd.setPolicy('grok-build', 'all');
    await budd.setPolicy('claude-desktop', 'all');
  });

  const ids = async (filter: Parameters<typeof budd.admin.history>[1]['filter']) =>
    (await budd.admin.history(budd.adminCtx, { limit: 100, filter })).items.map(
      (i) => i.message.bodyMd,
    );

  it('searches subject and body case-insensitively, taking % and _ literally', async () => {
    await send('Deploy at 100% capacity');
    await send('deploy_v2 is green', { subject: 'Status' });
    await send('nothing here', { subject: 'DEPLOY notes' });
    expect(await ids({ text: 'deploy' })).toHaveLength(3);
    expect(await ids({ text: '100%' })).toEqual(['Deploy at 100% capacity']);
    expect(await ids({ text: 'y_v' })).toEqual(['deploy_v2 is green']);
    expect(await ids({ text: '%' })).toEqual(['Deploy at 100% capacity']);
  });

  it('filters by connection, handle, state, kind and time', async () => {
    await send('first');
    budd.clock.now += 2 * 3_600_000;
    await grok.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'reply',
    });
    await grok.ok('inbox', { handle: 'researcher' });
    expect(await ids({ connectionId: await idOf('grok-build') })).toEqual(['reply', 'first']);
    expect(await ids({ handle: 'researcher', connectionId: await idOf('claude-desktop') })).toEqual(
      [],
    );
    expect(await ids({ handle: 'researcher' })).toEqual(['reply', 'first']);
    expect(await ids({ state: 'read' })).toEqual(['first']);
    expect(await ids({ state: 'unread' })).toEqual(['reply']);
    expect(await ids({ type: 'notice' })).toEqual([]);
    expect(await ids({ since: budd.clock.now - 3_600_000 })).toEqual(['reply']);
    const { matching } = await budd.admin.history(budd.adminCtx, {
      limit: 1,
      filter: { connectionId: await idOf('grok-build') },
    });
    expect(matching).toBe(2);
  });

  it('shows the filters it applied, and ignores values it does not accept', async () => {
    await send('hello');
    const b = await signedIn();
    const { res, body } = await b.get(
      '/ui/messages?state=unread&mailbox=grok-build/researcher&kind=bogus&q=%3Cscript%3Ehi',
    );
    expect(res.status).toBe(200);
    expect(body).toMatch(/<option value="grok-build\/researcher" selected>/);
    expect(body).toMatch(/<option value="unread" selected>/);
    expect(body).not.toContain('bogus');
    expect(body).not.toContain('<script>hi');
    expect(body).toContain('value="&lt;script&gt;hi"');
    expect(body).toMatch(/href="\/ui\/messages"\s*>Clear filters</);
    expect(body).toMatch(
      /class="filter-btn on"[\s\S]*?<span class="badge">3<span class="sr-only"> applied/,
    );
    for (const q of ['mailbox=../x', 'mailbox=nobody', 'q=' + 'x'.repeat(101), 'from=yesterday']) {
      expect((await b.get(`/ui/messages?${q}`)).res.status, q).toBe(200);
    }
    // Old links that filtered by connection still work.
    expect((await b.get('/ui/messages?connection=grok-build')).body).toMatch(
      /<option value="grok-build" selected>/,
    );
  });

  it('shows the last 24 hours unless asked for another window, in the reader’s time zone', async () => {
    await send('old one');
    budd.clock.now += 2 * 86_400_000;
    await send('new one');
    const b = await signedIn();
    const now = (await b.get('/ui/messages?view=list')).body;
    expect(now).toContain('new one');
    expect(now).not.toContain('old one');
    // The boxes are filled in, the defaults marked so app.js doesn't send them.
    expect(now).toMatch(
      /name="from"\s+value="\d{4}-\d\d-\d\dT\d\d:\d\d"\s+data-utc\s+data-default/,
    );
    const from = new Date(budd.clock.now - 3 * 86_400_000).toISOString().slice(0, 16);
    const wide = (await b.get(`/ui/messages?view=list&from=${from}`)).body;
    expect(wide).toContain('old one');
    // Two hours ahead of UTC, the same minute is two hours earlier.
    const to = new Date(budd.clock.now - 86_400_000).toISOString().slice(0, 16);
    const before = (await b.get(`/ui/messages?view=list&from=${from}&to=${to}&tz=-120`)).body;
    expect(before).toContain('old one');
    expect(before).not.toContain('new one');
  });

  it('marks what matched, escaping the message around it', async () => {
    await send('<b>alpha</b> beta ALPHA');
    const { body } = await (await signedIn()).get('/ui/messages?q=alpha');
    expect(body).toContain('&lt;b&gt;<mark>alpha</mark>&lt;/b&gt; beta <mark>ALPHA</mark>');
  });

  it('shows threads, with replies in order and linked to what they answer', async () => {
    const first = await send('question', { subject: 'Review the erase branch' });
    await grok.ok('inbox', { handle: 'researcher' });
    await grok.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'answer',
      reply_to: first.message_id,
    });
    await send('unrelated', { subject: 'Other' });
    const heads = await budd.admin.threadHeads(budd.adminCtx, [String(first.thread_id)]);
    expect(heads.map((h) => [h.first.message.subject, h.messages])).toEqual([
      ['Review the erase branch', 2],
    ]);

    const b = await signedIn();
    // One column: each thread's first message, its replies under it behind a toggle.
    const all = (await b.get('/ui/messages')).body;
    expect(all).toContain('2 threads with messages in the last 24 hours.');
    expect(all).toMatch(
      /question[\s\S]*<details class="replies" id="t-[^"]+"\s*>[\s\S]*1 reply[\s\S]*answer/,
    );
    // A thread opened by link shows open, whatever the window.
    budd.clock.now += 3 * 86_400_000;
    const later = await signedIn(); // the first session timed out
    const page = await later.get(`/ui/messages?thread=${String(first.thread_id)}`);
    expect(page.body).toMatch(
      /question[\s\S]*<details class="replies" id="t-[^"]+" open>[\s\S]*answer/,
    );
    // A reply outside the filters is counted, not shown.
    const filtered = await later.get(`/ui/messages?q=question&from=2000-01-01T00:00`);
    expect(filtered.body).toContain('1 thread with messages in this window.');
    expect(filtered.body).toContain('1 reply not shown');
    expect((await later.get('/ui/messages?thread=01J0000000000000000000NOPE')).res.status).toBe(
      200,
    );
  });
});

describe('the audit log', () => {
  it('filters by event, actor, connection and details', async () => {
    await budd.admin.block(budd.adminCtx, 'grok-build');
    const page = async (filter: Parameters<typeof budd.admin.auditPage>[1]['filter']) =>
      (await budd.admin.auditPage(budd.adminCtx, { limit: 100, filter })).rows.map((r) => r.event);
    expect(await page({ events: ['connection_blocked'] })).toEqual(['connection_blocked']);
    expect(await page({ actor: 'human' })).toEqual(['connection_blocked']);
    expect(await page({ connectionId: await idOf('claude-desktop') })).not.toContain(
      'connection_blocked',
    );
    expect(await page({ text: 'grok-build/researcher' })).toEqual(['handle_first_seen']);

    expect(await page({ mailbox: 'grok-build/researcher' })).toEqual(['handle_first_seen']);
    expect(await page({ mailbox: 'grok-build/research' })).toEqual([]);

    const b = await signedIn();
    const { body } = await b.get('/ui/audit?event=connection_blocked');
    expect(body).toContain('1 entry matches');
    expect(body).toContain('Connection blocked'); // events in words
    // A whole group at once, and a mailbox's own entries.
    expect((await b.get('/ui/audit?event=g-connections')).body).toContain('Connection blocked');
    const mailbox = (await b.get('/ui/audit?mailbox=grok-build/researcher')).body;
    expect(mailbox).toContain('1 entry matches');
    expect(mailbox).toContain('href="/ui/connections/grok-build/mailboxes/researcher"');
  });

  it('shows entries whose event it has no words for', async () => {
    const store = await budd.internals.gateway.forAdmin(budd.adminCtx);
    await store.appendAudit({
      at: budd.clock.now,
      event: 'from_the_future' as AuditEventType,
      actor: 'system',
      connectionId: null,
      detail: {},
    });
    const { res, body } = await (await signedIn()).get('/ui/audit');
    expect(res.status).toBe(200);
    expect(body).toContain('from_the_future');
  });

  it('pages back through older entries', async () => {
    for (let i = 0; i < 3; i++)
      await budd.admin.relabel(budd.adminCtx, 'grok-build', `l${String(i)}`);
    const all = (await budd.admin.auditPage(budd.adminCtx, { limit: 100 })).rows;
    const older = await budd.admin.auditPage(budd.adminCtx, {
      limit: 2,
      beforeId: all[1]?.id,
    });
    expect(older.rows.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id));
  });
});

describe('connection and settings pages', () => {
  it('a connection has its own page, and the old policy address leads to it', async () => {
    const b = await signedIn();
    const page = await b.get('/ui/connections/grok-build');
    expect(page.res.status).toBe(200);
    expect(page.body).toContain('action="/ui/connections/grok-build/label"');
    expect(page.body).toContain('action="/ui/connections/grok-build/policy"');
    expect(page.body).toContain('action="/ui/connections/grok-build/block"');
    const old = await b.get('/ui/connections/grok-build/policy');
    expect(old.res.status).toBe(301);
    expect(old.res.headers.get('location')).toBe('/ui/connections/grok-build#policy');
  });

  it('settings show the workspace and login, and are the one way to deleting it', async () => {
    const b = await signedIn();
    for (const [old, section] of [
      ['preferences', 'appearance'],
      ['account', 'account'],
      ['workspace', 'workspace'],
      ['about', 'about'],
    ]) {
      const r = await b.get(`/ui/settings/${old ?? ''}`);
      expect(r.res.status).toBe(301);
      expect(r.res.headers.get('location')).toBe(`/ui/settings#${section ?? ''}`);
    }
    const { body } = await b.get('/ui/settings');
    expect(body).toContain('<code>local</code>');
    expect(body).toContain('href="/ui/erase"');
    expect(body).toContain(USERNAME);
    expect((await b.get('/ui')).body).not.toContain('href="/ui/erase"');
  });

  it('the account menu holds the workspace, Settings, Console and Sign out, with no Settings tab', async () => {
    const { body } = await (await signedIn()).get('/ui');
    expect(body).not.toMatch(
      /<nav aria-label="Sections">[\s\S]*Settings[\s\S]*?<\/nav>\s*<div class="end">/,
    );
    const menu = /<details class="profile" data-menu>[\s\S]*?<\/details>/.exec(body)?.[0] ?? '';
    expect(menu).toContain(
      '<span class="label">Workspace</span><a class="name" href="/ui">local</a>',
    );
    expect(menu).toContain('href="/ui/settings"');
    // Local mode's one login is the operator; the console opens in a new tab.
    expect(menu).toMatch(/<a class="out" href="\/console" target="_blank"/);
    expect(menu).toContain('action="/logout"');
    expect(menu).toMatch(/<span class="avatar initial" aria-hidden="true">A<\/span>/); // no picture locally
  });

  it('a chosen theme is saved to the account and applied to every page', async () => {
    const b = await signedIn();
    expect((await b.get('/ui')).body).not.toContain('data-theme=');
    const page = await b.get('/ui/settings');
    expect(page.body).toMatch(/value="system"\s*checked/);
    const saved = await b.post('/ui/settings/preferences', [
      ['_csrf', field(page.body, '_csrf')],
      ['theme', 'dark'],
    ]);
    expect(saved.res.headers.get('location')).toBe('/ui/settings?done=saved#appearance');
    const ui = (await b.get('/ui')).body;
    expect(ui).toMatch(/<html\s+lang="en"\s+data-theme="dark"\s*>/);
    // The logo follows the chosen theme, not the device's.
    expect(ui).toContain('src="/ui/logo/budd-wordmark-dark.svg"');
    expect(ui).not.toContain('media="(prefers-color-scheme: dark)"');
    // And a second browser signed in as the same person gets it too.
    expect((await (await signedIn()).get('/ui/messages')).body).toContain('data-theme="dark"');
    const bad = await b.post('/ui/settings/preferences', [
      ['_csrf', field(page.body, '_csrf')],
      ['theme', 'neon'],
    ]);
    expect(bad.res.status).toBe(400);
  });
});

describe('review fixes', () => {
  it('filters the audit log and messages by Budd itself', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
      ttl: '1m',
    });
    budd.clock.now += 120_000;
    await budd.sweep(); // the expiry notice comes from the system connection
    const b = await signedIn();
    expect((await b.get('/ui/audit?connection=budd')).res.status).toBe(200);
    const messages = await b.get('/ui/messages?view=list&mailbox=budd');
    expect(messages.res.status).toBe(200);
    expect(messages.body).toContain('1 message matches');
  });

  it('offers a way back to the newest after paging', async () => {
    const b = await signedIn();
    const page = await b.get('/ui/messages?view=list&before=01J1QZ8X4M0000000000000000');
    expect(page.body).toContain('Back to the newest');
  });

  it('marks matches even where lowercasing changes the length of the text', async () => {
    const { highlight } = await import('../src/ui/messagePages.js');
    expect(String(await highlight('İstanbul bul', 'bul'))).toBe(
      'İstan<mark>bul</mark> <mark>bul</mark>',
    );
  });

  it('a long thread counts every message, and shows them all when opened', async () => {
    await budd.setPolicy('grok-build', 'all');
    const first = await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'm0',
    });
    for (let i = 1; i <= 100; i++) {
      if (i % 40 === 0) await grok.ok('inbox', { handle: 'researcher', limit: 50 }); // stay under the unread caps
      await claude.ok('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        body_md: `m${String(i)}`,
        thread_id: first.thread_id,
      });
    }
    const [head] = await budd.admin.threadHeads(budd.adminCtx, [String(first.thread_id)]);
    expect(head?.first.message.bodyMd).toBe('m0');
    expect(head?.messages).toBe(101);
    const page = (await (await signedIn()).get(`/ui/messages?thread=${String(first.thread_id)}`))
      .body;
    expect(page).toContain('100 replies');
    expect(page).toContain('m100');
  });
});

describe('security review fixes', () => {
  it('spells out invisible and direction characters in the audit console', async () => {
    await budd.admin.relabel(budd.adminCtx, 'grok-build', 'evil‮txt.exe');
    const { body } = await (await signedIn()).get('/ui/audit?event=connection_relabelled');
    expect(body).not.toContain('‮');
    expect(body).toContain('evil\\u202etxt.exe');
  });

  it('marks at most 50 matches in one text', async () => {
    const { highlight } = await import('../src/ui/messagePages.js');
    const out = String(await highlight('a'.repeat(1000), 'a'));
    expect(out.match(/<mark>/g)).toHaveLength(50);
    expect(out.length).toBeLessThan(2000);
  });

  it('a notice names the page’s own connection, never one from the link', async () => {
    const b = await signedIn();
    const { body } = await b.get(
      '/ui/connections/grok-build?done=blocked&slug=everyone.%20Re-enter',
    );
    expect(body).toContain('Blocked grok-build.');
    expect(body).not.toContain('Re-enter');
  });
});

describe('connections, mailboxes and the map', () => {
  it('maps who can message whom: one-way, both ways, and connections cut off', async () => {
    const lone = await budd.connect('scratch');
    await lone.ok('whoami');
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    const b = await signedIn();
    let body = (await b.get('/ui')).body;
    expect(body).toMatch(
      /<line\s+class="map-edge one"\s+data-from="claude-desktop"\s+data-to="grok-build"/,
    );
    expect(body).toMatch(/data-node="scratch"/);
    expect(body).toContain('class="map-node cut-off"');
    expect(body).toContain('scratch can’t message anyone'.replace('’', "'"));
    expect(body).toContain('claude-desktop can message grok-build.');
    await budd.setPolicy('claude-desktop', 'allowlist', ['grok-build']);
    body = (await b.get('/ui')).body;
    expect(body).toMatch(/class="map-edge both"/);
    expect(body).toContain('claude-desktop and grok-build can message each other.');
    // A blocked connection can do neither.
    await budd.admin.block(budd.adminCtx, 'grok-build');
    body = (await b.get('/ui')).body;
    expect(body).not.toContain('class="map-edge');
    await lone.close();
  });

  it('has nothing to map until there are two connections', async () => {
    await budd.admin.archive(budd.adminCtx, 'grok-build');
    const b = await signedIn();
    expect((await b.get('/ui?view=map')).body.replace(/\s+/g, ' ')).toContain(
      "connected, so there's nothing to map yet",
    );
  });

  it('sorts the table by its headings, and finds by name, label, mailbox, status and unread mail', async () => {
    await budd.admin.relabel(budd.adminCtx, 'grok-build', 'Research box');
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    const b = await signedIn();
    const order = (body: string) => [...body.matchAll(/<tr id="c-([^"]+)"/g)].map((m) => m[1]);
    expect(order((await b.get('/ui?view=table')).body)).toEqual(['claude-desktop', 'grok-build']);
    const desc = (await b.get('/ui?view=table&sort=name&dir=desc')).body;
    expect(order(desc)).toEqual(['grok-build', 'claude-desktop']);
    expect(desc).toMatch(
      /<th aria-sort="descending">\s*<a\s+class="sort on"\s+href="\/ui\?view=table&amp;sort=name&amp;dir=asc"/,
    );
    for (const [q, found] of [
      ['q=research', ['grok-build']],
      ['q=chief', ['claude-desktop']],
      ['unread=1', ['grok-build']],
      ['status=blocked', []],
    ] as const) {
      expect(order((await b.get(`/ui?view=table&${q}`)).body), q).toEqual(found);
    }
    expect((await b.get('/ui?view=table&status=blocked')).body).toContain('No connections match.');
  });

  it('a connection’s name opens its messages and audit log; each mailbox row does too', async () => {
    const b = await signedIn();
    const { body } = await b.get('/ui/connections/grok-build?sort=unread&dir=desc');
    const menu = /<details class="go" data-menu>[\s\S]*?<\/details>/.exec(body)?.[0] ?? '';
    expect(menu).toContain('href="/ui/messages?mailbox=grok-build"');
    expect(menu).toContain('href="/ui/audit?connection=grok-build"');
    expect(body).toContain('href="/ui/connections/grok-build/mailboxes/researcher"');
    expect(body).toContain('href="/ui/messages?mailbox=grok-build%2Fresearcher"');
    expect(body).toContain('href="/ui/audit?mailbox=grok-build%2Fresearcher"');
    expect(body).toMatch(
      /<th aria-sort="descending">\s*<a\s+class="sort on"\s+href="\/ui\/connections\/grok-build\?sort=unread&amp;dir=asc"/,
    );
  });

  it('a mailbox has its own page: a summary of its mail, not a list', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      subject: 'Plans',
      body_md: 'the body itself',
    });
    const b = await signedIn();
    const { res, body } = await b.get('/ui/connections/grok-build/mailboxes/researcher');
    expect(res.status).toBe(200);
    expect(body).toContain('1 unread message');
    expect(body).toMatch(/Newest:\s+<span class="subject">Plans<\/span> from/);
    expect(body).not.toContain('the body itself');
    expect(body).toContain('href="/ui/audit?mailbox=grok-build%2Fresearcher"');
    for (const path of [
      '/ui/connections/grok-build/mailboxes/nobody',
      '/ui/connections/nobody/mailboxes/x',
    ]) {
      expect((await b.get(path)).res.status, path).toBe(404);
    }
  });
});

describe('the map', () => {
  const routes = (body: string) =>
    [...body.matchAll(/<g\s+class="route ([^"]+)"\s+data-a="([^"]+)"\s+data-b="([^"]+)"/g)].map(
      ([, cls, a, b]) => ({ cls, a, b }),
    );

  it('is where Connections opens once there are two connections; until then, the table', async () => {
    await budd.admin.archive(budd.adminCtx, 'grok-build');
    await claude.ok('inbox_count', { handle: 'writer' });
    const b = await signedIn();
    expect((await b.get('/ui')).body).toMatch(/href="\/ui\?view=table" aria-current="page"/);
    expect((await b.get('/ui?view=map')).body).toMatch(/href="\/ui\?view=map" aria-current="page"/);
    await budd.connect('cursor');
    expect((await b.get('/ui')).body).toMatch(/href="\/ui\?view=map" aria-current="page"/);
  });

  it('puts each mailbox on its connection, and links it to its card', async () => {
    const body = (await (await signedIn()).get('/ui')).body;
    expect(body).toMatch(
      /<a\s+class="mb"\s+href="\/ui\?view=map&amp;card=grok-build%2Fresearcher"/,
    );
    expect(body).toMatch(
      /<g data-of="claude-desktop">\s*<a\s+class="map-node[^"]*"[\s\S]*?data-mb="claude-desktop\/chief-of-staff"/,
    );
    expect(body).toContain('aria-label="grok-build/researcher: nothing unread."');
  });

  it('shows the messages sent in a window: share, unread and direction', async () => {
    await budd.setPolicy('grok-build', 'all');
    await budd.setPolicy('claude-desktop', 'all');
    for (let i = 0; i < 3; i++) {
      await claude.ok('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        body_md: 'hi',
      });
    }
    await grok.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'hi',
    });
    await grok.ok('inbox_count', { handle: 'writer' });
    await grok.ok('send', { to: ['grok-build/writer'], from_handle: 'researcher', body_md: 'hi' });
    await grok.ok('inbox', { handle: 'writer' });
    const b = await signedIn();
    expect(routes((await b.get('/ui')).body)).toEqual([]);
    const body = (await b.get('/ui?view=map&msgs=7d')).body;
    // Both ways: solid. 4 of 4 unread: all orange. One way and read: moving and blue.
    expect(routes(body)).toEqual([
      { cls: 'both u4', a: 'claude-desktop/chief-of-staff', b: 'grok-build/researcher' },
      { cls: 'one u0', a: 'grok-build/researcher', b: 'grok-build/writer' },
    ]);
    expect(body).toMatch(/stroke-width="11\.1"/); // 4 of 5 messages
    expect(body).toContain(
      'claude-desktop/chief-of-staff and grok-build/researcher: 4 messages both ways. 80% of all sent; 4 not read (100%).',
    );
    expect(body).toContain(
      'grok-build/researcher to grok-build/writer: 1 message, one way only. 20% of all sent; all read.',
    );
    // A mailbox says who it wrote to and heard from, here and on its card.
    expect(body).toContain(
      'grok-build/researcher: 3 unread. Sent 1 to claude-desktop/chief-of-staff and received 3 from it; sent 1 to grok-build/writer.',
    );
    const card = (await b.get('/ui?view=map&card=grok-build%2Fresearcher')).body;
    expect(card.replace(/\s+/g, ' ')).toContain(
      'Messages with</dt> <dd> Sent 1 to claude-desktop/chief-of-staff and received 3 from it; sent 1 to grok-build/writer. </dd>',
    );
    // Outside the window, nothing.
    budd.clock.now += 2 * 86_400_000;
    const later = (await (await signedIn()).get('/ui?view=map&msgs=1d')).body;
    expect(routes(later)).toEqual([]);
    expect(later.replace(/\s+/g, ' ')).toMatch(
      /No messages in the last day\. Try <a href="\/ui\?view=map&amp;msgs=7d" >7 days<\/a > or <a/,
    );
  });

  it('puts a mailbox on the edge facing the mailboxes it messages', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('inbox_count', { handle: 'notes' });
    await budd.connect('cursor');
    const b = await signedIn();
    // Three connections: claude-desktop at the top, the others below it.
    const edge = async (url: string) =>
      /data-mb="claude-desktop\/chief-of-staff"\s+data-ox="[^"]+"\s+data-oy="([^"]+)"/.exec(
        (await b.get(url)).body,
      )?.[1];
    expect(await edge('/ui?view=map')).toBe('-33');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    expect(await edge('/ui?view=map&msgs=7d')).toBe('33');
  });

  it('reuses a count of routes for 30 seconds, and opens a card on its own for app.js', async () => {
    await budd.setPolicy('grok-build', 'all');
    const b = await signedIn();
    const send = () =>
      claude.ok('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        body_md: 'hi',
      });
    const count = async () =>
      /(\d+) messages?, one way only/.exec((await b.get('/ui?view=map&msgs=7d')).body)?.[1];
    await send();
    expect(await count()).toBe('1');
    await send();
    expect(await count()).toBe('1');
    budd.clock.now += 30_000;
    expect(await count()).toBe('2');
    const res = await fetch(`${budd.url}/ui?view=map&msgs=7d&card=grok-build`, {
      headers: { cookie: b.cookie ?? '', 'x-budd-part': 'card' },
    });
    const part = await res.text();
    expect(part).toMatch(/^<dialog class="card" data-card open/);
    expect(part).not.toContain('<svg class="map');
  });

  it('counts expired mail as unread', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
      ttl: '1h',
    });
    budd.clock.now += 2 * 3_600_000;
    await budd.sweep();
    const body = (await (await signedIn()).get('/ui?view=map&msgs=7d')).body;
    expect(routes(body)).toEqual([
      { cls: 'one u4', a: 'claude-desktop/chief-of-staff', b: 'grok-build/researcher' },
    ]);
    const card = (await (await signedIn()).get('/ui?view=map&card=grok-build%2Fresearcher')).body;
    expect(card.replace(/\s+/g, ' ')).toMatch(
      /Expired<\/dt> <dd><span class="num">1<\/span> in the last 7 days/,
    );
    // The sender's expiry notice isn't a message it received.
    const sender = (
      await (await signedIn()).get('/ui?view=map&card=claude-desktop%2Fchief-of-staff')
    ).body;
    expect(sender.replace(/\s+/g, ' ')).toMatch(
      /<span class="num">1<\/span> sent, <span class="num">0<\/span> received/,
    );
  });

  it('opens a connection’s card, and a mailbox’s, with links to its pages', async () => {
    await budd.setPolicy('grok-build', 'all');
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    budd.clock.now += 60_000;
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    await grok.ok('inbox', { handle: 'researcher', limit: 1 });
    const b = await signedIn();
    let body = (await b.get('/ui?view=map&card=grok-build')).body.replace(/\s+/g, ' ');
    expect(body).toContain('<dialog class="card" data-card open aria-labelledby="card-title">');
    expect(body).toContain(
      'href="/ui/connections/grok-build" aria-label="Open grok-build&#39;s page"',
    );
    expect(body).toContain('href="/ui/messages?mailbox=grok-build"');
    expect(body).toContain('href="/ui/audit?connection=grok-build"');
    expect(body).toMatch(
      /Last 7 days<\/dt> <dd><span class="num">0<\/span> sent, <span class="num">2<\/span> received/,
    );
    expect(body).toContain('href="/ui?view=map" data-card-close');
    expect(body).toContain('href="/ui?view=map&amp;focus=grok-build"');
    body = (await b.get('/ui?view=map&card=grok-build%2Fresearcher')).body.replace(/\s+/g, ' ');
    expect(body).toContain('href="/ui/messages?mailbox=grok-build%2Fresearcher"');
    expect(body).toMatch(
      /Unread now<\/dt> <dd> <span class="num">1<\/span>, the oldest from <time datetime="2026-10-15T12:01:00.000Z"/,
    );
    expect(body).toMatch(/Last read<\/dt> <dd><time datetime="2026-10-15T12:01:00.000Z"/);
    expect(body).toMatch(/Wake-up<\/dt> <dd> <span class="muted">Off<\/span>/);
    // Not a card: an unknown connection, or a mailbox it doesn't have.
    for (const card of ['nobody', 'grok-build%2Fnobody', '..%2F..']) {
      const r = await b.get(`/ui?view=map&card=${card}`);
      expect(r.res.status, card).toBe(200);
      expect(r.body, card).not.toContain('data-card');
    }
  });

  it('fades whatever a focused connection can’t reach', async () => {
    const lone = await budd.connect('scratch');
    await lone.ok('inbox_count', { handle: 'notes' });
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    const body = (await (await signedIn()).get('/ui?view=map&focus=grok-build')).body;
    expect(body).toMatch(/class="map-node cut-off dim"[^>]*data-node="scratch"/);
    expect(body).toMatch(/class="map-node"[^>]*data-node="claude-desktop"/);
    expect(body).toMatch(/<option value="grok-build" selected>/);
  });

  it('lays out many connections without overlapping, and the same way each time', async () => {
    for (let i = 0; i < 14; i++) {
      const a = await budd.connect(`agent-${String(i)}`);
      await a.ok('inbox_count', { handle: 'one' });
    }
    for (let i = 0; i < 14; i++) {
      await budd.setPolicy(`agent-${String(i)}`, 'allowlist', [
        `agent-${String((i + 1) % 14)}`,
        'claude-desktop',
      ]);
    }
    const b = await signedIn();
    const body = (await b.get('/ui')).body;
    const boxes = [...body.matchAll(/data-x="(\d+)"\s+data-y="(\d+)"\s+data-w="(\d+)"/g)].map(
      ([, x, y, w]) => ({ x: Number(x), y: Number(y), w: Number(w), h: 66 }),
    );
    expect(boxes.length).toBe(16);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        // Apart, counting the mailboxes half outside each box.
        const apart =
          Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + 24;
        expect(apart).toBe(true);
      }
    }
    expect((await b.get('/ui')).body).toBe(body);
  });
});

describe('filters', () => {
  it('sit behind a button: outline with none applied, filled with a count when some are', async () => {
    const b = await signedIn();
    let body = (await b.get('/ui/audit')).body;
    expect(body).toMatch(/<summary class="filter-btn">/);
    expect(body).not.toContain('Clear filters');
    body = (
      await b.get(
        '/ui/audit?event=connection_registered&q=grok&from=2026-10-01T00:00&to=2026-10-20T00:00',
      )
    ).body;
    // From and To are one filter.
    expect(body).toMatch(
      /<summary class="filter-btn on">[\s\S]*?<span class="badge">3<span class="sr-only"> applied/,
    );
    expect(body).toMatch(/href="\/ui\/audit"\s*>Clear filters</);
    // Cancel goes back to what's applied.
    expect(body).toMatch(
      /<a class="btn" href="\/ui\/audit\?[^"]*event=connection_registered[^"]*" data-drawer-cancel>Cancel<\/a>/,
    );
    // The table keeps its view.
    body = (await b.get('/ui?view=table&unread=1')).body;
    expect(body).toMatch(/<input type="hidden" name="view" value="table" \/>/);
    expect(body).toMatch(/href="\/ui\?view=table"\s*>Clear filters</);
  });
});
