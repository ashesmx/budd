import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { envSchema, loadConfig } from '../src/config.js';
import { SETTINGS } from '../src/settings.js';
import { MAX_SESSIONS_PER_ACCOUNT, UiSessions } from '../src/ui/sessions.js';
import { createOperatorLink, listOperatorsOffline } from '../src/storage/sqlite/operators.js';
import { HOUR_MS, USAGE_KEPT_MS } from '../src/sweeper/usage.js';
import { startTestBudd, type TestBudd } from './helpers/harness.js';
import { Browser, field, startHostedBudd, type HostedBudd } from './helpers/hosted.js';

const alice = { sub: 'alice-sub', email: 'alice@example.com', name: 'Alice Example' };
const bob = { sub: 'bob-sub', email: 'bob@example.org' };

let budd: HostedBudd | TestBudd | undefined;
afterEach(async () => {
  await budd?.close();
  budd = undefined;
});

/** Signs `user` in to the UI, then makes them an operator with a `budd operator` link. */
async function enrol(b: HostedBudd, user: typeof alice): Promise<Browser> {
  const browser = new Browser(b);
  await browser.signIn(user);
  const code = await createOperatorLink(b.dataDir, user.email, b.clock.now);
  const page = await browser.go(`/console/enrol?code=${code}`);
  expect(page.body).toContain('Make this account an operator?');
  expect(page.body).toContain(user.email);
  const done = await browser.post('/console/enrol', [
    ['_csrf', field(page.body, '_csrf')],
    ['code', code],
  ]);
  expect(done.body).toContain('Sign in to the console');
  return browser;
}

const signInToConsole = (browser: Browser) =>
  browser.post('/console/login', [['return', '/console']]);

describe('the operator console, hosted', () => {
  it('a budd operator link makes the account that signs in an operator, once', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    const overview = await signInToConsole(browser);
    expect(overview.status).toBe(200);
    expect(overview.url).toBe(`${b.url}/console`);
    expect(overview.body).toContain('<h1>Overview</h1>');
    expect(overview.body).toContain('class="app-header op-header"');
    expect(listOperatorsOffline(b.dataDir).map((o) => o.email)).toEqual([alice.email]);

    // The link is used up.
    const bobBrowser = new Browser(b);
    await bobBrowser.signIn(bob);
    const code = await createOperatorLink(b.dataDir, bob.email, b.clock.now);
    const page = await bobBrowser.go(`/console/enrol?code=${code}`);
    const csrf = field(page.body, '_csrf');
    await bobBrowser.post('/console/enrol', [
      ['_csrf', csrf],
      ['code', code],
    ]);
    const again = await new Browser(b).go(`/console/enrol?code=${code}`);
    expect(again.body).not.toContain('Make this account an operator?');
    const reused = await bobBrowser.post('/console/enrol', [
      ['_csrf', csrf],
      ['code', code],
    ]);
    expect(reused.status).toBe(400);
    expect(reused.body).toContain('Operator link not valid');
  });

  it('a link works only for the account with its email, and isn’t used up by another', async () => {
    const b = await startHostedBudd();
    budd = b;
    const code = await createOperatorLink(b.dataDir, alice.email.toUpperCase(), b.clock.now);
    const bobBrowser = new Browser(b);
    await bobBrowser.signIn(bob);
    const refused = await bobBrowser.go(`/console/enrol?code=${code}`);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('Operator link is for another account');
    expect(refused.body).not.toContain(alice.email);
    // Nor by posting it straight, with a valid form.
    const csrf = field((await bobBrowser.go('/ui')).body, '_csrf');
    const posted = await bobBrowser.post('/console/enrol', [
      ['_csrf', csrf],
      ['code', code],
    ]);
    expect(posted.status).toBe(403);
    expect(await b.internals.storage.console.listOperators()).toEqual([]);

    const aliceBrowser = new Browser(b);
    await aliceBrowser.signIn(alice);
    const page = await aliceBrowser.go(`/console/enrol?code=${code}`);
    expect(page.body).toContain('Make this account an operator?');
  });

  it('an expired link does nothing', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = new Browser(b);
    await browser.signIn(alice);
    const code = await createOperatorLink(b.dataDir, alice.email, b.clock.now);
    b.clock.now += 11 * 60_000;
    const page = await browser.go(`/console/enrol?code=${code}`);
    expect(page.status).toBe(400);
    expect(await b.internals.storage.console.listOperators()).toEqual([]);
  });

  it('an account that isn’t an operator gets a 403, signed in to the UI or not', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = new Browser(b);
    await browser.signIn(bob);
    const first = await browser.go('/console');
    expect(first.body).toContain('Sign in to the console'); // a UI session isn't enough
    const refused = await signInToConsole(browser);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatch(/^Refused: this account isn’t an operator/);
  });

  it('the console has its own session: neither opens the other', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    await signInToConsole(browser);
    const consoleId = browser.cookies.get('budd_console') ?? '';
    const uiId = browser.cookies.get('budd_session') ?? '';
    expect(consoleId).not.toBe('');
    const asUi = await fetch(`${b.url}/ui`, {
      headers: { cookie: `budd_session=${consoleId}` },
      redirect: 'manual',
    });
    expect(asUi.status).toBe(302);
    const asConsole = await fetch(`${b.url}/console`, {
      headers: { cookie: `budd_console=${uiId}` },
    });
    expect(await asConsole.text()).toContain('Sign in to the console');
  });

  it('a removed operator loses the console at once', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    await signInToConsole(browser);
    const [op] = await b.internals.storage.console.listOperators();
    await b.internals.storage.console.removeOperator(op?.accountId ?? '');
    const page = await browser.go('/console/accounts');
    expect(page.status).toBe(403);
  });

  it('shows accounts and workspaces by ID, never their emails, names or workspace names', async () => {
    const b = await startHostedBudd();
    budd = b;
    const other = new Browser(b);
    await other.signIn(bob);
    const browser = await enrol(b, alice);
    await signInToConsole(browser);
    await b.sweep();
    const accounts = await b.internals.storage.console.accounts();
    for (const path of ['/console', '/console/accounts', '/console/workspaces']) {
      const page = await browser.go(path);
      expect(page.status, path).toBe(200);
      expect(page.body, path).not.toContain(bob.email);
      expect(page.body, path).not.toMatch(/>bob</);
    }
    const list = (await browser.go('/console/accounts')).body;
    for (const a of accounts) expect(list).toContain(a.id);
    const bobsWorkspace = accounts.find((a) => !a.operator)?.workspaceIds[0] ?? '';
    const ws = await browser.go(`/console/workspaces/${bobsWorkspace}`);
    expect(ws.body).toContain('Messages stored');
    expect(ws.body).toContain('data-chart');
    // A small workspace's figures are in KB, not rounded down to 0 MB.
    expect(ws.body).toMatch(/\d+ KB/);
    expect(ws.body).not.toContain('0.0 MB');
    expect((await browser.go('/console/workspaces/nope')).status).toBe(404);
  });

  it('the console’s menu signs out of both the console and the UI', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    const overview = await signInToConsole(browser);
    const out = await browser.post('/console/logout', [['_csrf', field(overview.body, '_csrf')]]);
    expect(out.body).toContain('Signed out');
    expect((await browser.go('/ui')).url).toContain('/login');
    expect((await browser.go('/console')).body).toContain('Sign in to the console');
  });

  it('signing out of the UI ends the console session in that browser too', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    await signInToConsole(browser);
    const consoleId = browser.cookies.get('budd_console') ?? '';
    const ui = await browser.go('/ui');
    await browser.post('/logout', [['_csrf', field(ui.body, '_csrf')]]);
    const after = await fetch(`${b.url}/console`, {
      headers: { cookie: `budd_console=${consoleId}` },
    });
    expect(await after.text()).toContain('Sign in to the console');
  });

  it('operators see Console in the account menu; others don’t', async () => {
    const b = await startHostedBudd();
    budd = b;
    const browser = await enrol(b, alice);
    expect((await browser.go('/ui')).body).toContain('href="/console" target="_blank"');
    const other = new Browser(b);
    await other.signIn(bob);
    expect((await other.go('/ui')).body).not.toContain('href="/console"');
  });

  it('Environment shows secrets only as set, and ALLOWED_EMAILS only as a count', async () => {
    const b = await startHostedBudd({
      ALLOWED_EMAILS: `${alice.email},@example.org`,
      BUDD_SECRET_KEY: 'a'.repeat(64),
    });
    budd = b;
    const browser = await enrol(b, alice);
    await signInToConsole(browser);
    const page = (await browser.go('/console/environment')).body;
    expect(page).toContain('1 address and 1 domain');
    expect(page).not.toContain(alice.email);
    expect(page).not.toContain('a'.repeat(64));
    expect(page).not.toContain(b.idp.clientSecret);
    expect(page).toContain('MAX_WORKSPACE_MB');
    // Settings that decide who gets in, or what leaves, are marked, and the secrets.
    expect(page).toMatch(/<tr id="OPEN_SIGNUP" class="op-security">/);
    expect(page).toMatch(/<tr id="MAX_WORKSPACE_MB" class="">/);
    expect(page).toMatch(/id="BUDD_SECRET_KEY"[\s\S]*?Security[\s\S]*?Secret/);
  });
});

describe('console sessions', () => {
  it('are capped apart from UI sessions, so signing in to one never ends the other', () => {
    const sessions = new UiSessions();
    const ui = Array.from({ length: MAX_SESSIONS_PER_ACCOUNT }, () => sessions.signIn('a', 'w'));
    const op = sessions.signIn('a', 'w', { console: true });
    expect(ui.every((s) => sessions.get(s.id))).toBe(true);
    sessions.signIn('a', 'w');
    expect(sessions.get(op.id)).toBeDefined();
  });
});

describe('the operator console, local mode', () => {
  it('the UI login is the operator: no link, no second sign-in', async () => {
    const b = await startTestBudd();
    budd = b;
    const anonymous = await fetch(`${b.url}/console`, { redirect: 'manual' });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toBe('/login?return=%2Fconsole');
    const cookie = await b.uiCookie();
    const page = await fetch(`${b.url}/console/environment`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<h1>Environment</h1>');
    expect(body).not.toContain('PUBLIC_URL'); // hosted mode only
    expect((await fetch(`${b.url}/console/enrol`, { headers: { cookie } })).status).toBe(404);
  });
});

describe('storage measured hourly', () => {
  it('once an hour, kept for 30 days', async () => {
    const b = await startTestBudd();
    budd = b;
    const store = b.internals.storage.console;
    const hour = Math.floor(b.clock.now / HOUR_MS) * HOUR_MS;
    await b.sweep();
    expect(await store.lastUsageHour()).toBe(hour);
    const [ws] = await store.workspaces(b.clock.now);
    expect(ws?.usage?.fileBytes).toBeGreaterThan(0);

    b.clock.now += 10 * 60_000; // the same hour: not measured again
    await b.sweep();
    expect(await store.usage(ws?.id ?? '', 0)).toHaveLength(1);

    b.clock.now = hour + USAGE_KEPT_MS + HOUR_MS;
    await b.sweep();
    const kept = await store.usage(ws?.id ?? '', 0);
    expect(kept.map((p) => p.hour)).toEqual([hour + USAGE_KEPT_MS + HOUR_MS]);
  });
});

describe('settings', () => {
  it('each default is the schema’s', () => {
    const fields = envSchema.shape as Record<string, { parse(v: unknown): unknown }>;
    for (const [key, info] of Object.entries(SETTINGS)) {
      if (info.default === undefined) continue;
      expect(fields[key]?.parse(info.default), key).toEqual(fields[key]?.parse(undefined));
    }
  });

  it('operating.md’s table lists every setting with the same default', () => {
    const doc = fs.readFileSync('docs/operating.md', 'utf8');
    const rows = [...doc.matchAll(/^\| `([A-Z_]+)`\s*\| ([^|]*?)\s*\|/gm)].map(
      (m) => [m[1] ?? '', m[2] ?? ''] as const,
    );
    expect(rows.map(([k]) => k).sort()).toEqual(Object.keys(SETTINGS).sort());
    for (const [key, shown] of rows) {
      const def = SETTINGS[key as keyof typeof SETTINGS].default;
      if (shown.startsWith('`')) expect(shown, key).toBe(`\`${def ?? ''}\``);
    }
  });

  it('.env.example names only real settings', () => {
    const example = fs.readFileSync('.env.example', 'utf8');
    const keys = [...example.matchAll(/^#?\s?([A-Z][A-Z_]+)=/gm)].map((m) => m[1] ?? '');
    const known = new Set([...Object.keys(SETTINGS), 'BUDD_PORT']); // BUDD_PORT is docker-compose's
    expect(keys.filter((k) => !known.has(k))).toEqual([]);
  });

  it('a recommendation flags a value that goes against it', () => {
    const open = loadConfig({ WAKE_UP_HOSTS: '*' }).settings.find((s) => s.key === 'WAKE_UP_HOSTS');
    expect(open?.differs).toBe(true);
    const key = loadConfig({}).settings.find((s) => s.key === 'BUDD_SECRET_KEY');
    expect(key).toMatchObject({ differs: true, set: false, value: undefined });
  });
});
