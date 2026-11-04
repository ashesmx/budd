import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalLoginState } from '../src/auth/localLogin.js';
import {
  blockConnectionOffline,
  listConnectionsOffline,
} from '../src/storage/sqlite/connectionsOffline.js';
import { DataDirInUseError } from '../src/storage/sqlite/dataDirLock.js';
import { createLoginLink } from '../src/storage/sqlite/loginLink.js';
import { resetLocalLogin } from '../src/storage/sqlite/resetLogin.js';
import { testStorage } from './helpers/harness.js';
import { startTestBudd, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
beforeEach(async () => {
  budd = await startTestBudd();
});
afterEach(async () => {
  await budd.close();
});

const setupCode = () => budd.internals.localLogin?.setupCode ?? '';

/** Cookie-keeping fetch for one browser. */
function browser() {
  let cookie = '';
  const go = async (p: string, form?: Record<string, string>) => {
    const res = await fetch(budd.url + p, {
      redirect: 'manual',
      ...(form && {
        method: 'POST',
        body: new URLSearchParams(form).toString(),
      }),
      headers: {
        ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(cookie && { cookie }),
      },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    return { res, body: await res.text() };
  };
  const csrf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { go, csrf, cookie: () => cookie };
}

async function setUp(username = 'alice', password = 'correct horse') {
  const b = browser();
  const page = await b.go(`/setup?code=${setupCode()}`);
  return b.go('/setup', {
    _csrf: b.csrf(page.body),
    code: setupCode(),
    username,
    password,
    confirm: password,
  });
}

describe('first-run setup', () => {
  it('starts with a one-time setup code and no login', async () => {
    expect(setupCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await budd.internals.storage.auth.getLocalLogin()).toBeUndefined();
  });

  it('refuses the setup page without the right code', async () => {
    for (const p of ['/setup', '/setup?code=wrong']) {
      expect((await browser().go(p)).res.status, p).toBe(400);
    }
  });

  it('checks the password', async () => {
    const b = browser();
    const page = await b.go(`/setup?code=${setupCode()}`);
    const post = (password: string, confirm: string) =>
      b.go('/setup', {
        _csrf: b.csrf(page.body),
        code: setupCode(),
        username: 'a',
        password,
        confirm,
      });
    expect((await post('short', 'short')).body).toMatch(/at least 8 characters/);
    const mismatch = (await post('long enough', 'different!')).body;
    expect(mismatch).toMatch(/don’t match/);
    expect(mismatch).toContain('value="a"');
  });

  it('offers to sign in from a bad setup link only once a login exists', async () => {
    expect((await browser().go('/setup?code=wrong')).body).not.toContain('href="/login"');
    await setUp();
    expect((await browser().go('/setup?code=wrong')).body).toContain('href="/login"');
  });

  it('creates the login, signs you in, and the code stops working', async () => {
    const r = await setUp();
    expect(r.res.status).toBe(303);
    expect(r.res.headers.get('location')).toBe('/ui');
    expect(budd.internals.localLogin?.setupCode).toBeUndefined();
    expect((await browser().go('/setup?code=anything')).res.status).toBe(400);
  });

  it('stores only a scrypt hash of the password', async () => {
    await setUp('alice', 'super secret pw');
    const login = await budd.internals.storage.auth.getLocalLogin();
    expect(login?.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    const raw = ['control.db', 'control.db-wal']
      .map((f) => path.join(budd.dataDir, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString('latin1'))
      .join('');
    expect(raw).not.toContain('super secret pw');
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('requires a login for every UI page and the event stream', async () => {
    for (const p of ['/ui', '/ui/messages', '/ui/audit', '/ui/connections/x/policy']) {
      const r = await browser().go(p);
      expect(r.res.status, p).toBe(302);
      expect(r.res.headers.get('location'), p).toMatch(/^\/login\?return=/);
    }
    expect((await fetch(`${budd.url}/ui/events`)).status).toBe(401);
  });

  it('signs in from a landing page that says how to connect an app', async () => {
    const { body } = await browser().go('/login');
    expect(body).toContain('<h1>Sign in to Budd</h1>');
    expect(body).toContain('Budd lets your AI apps message each other.');
    expect(body).toContain(`<code>${budd.url}/mcp/&lt;name&gt;</code>`);
    expect(body).toContain('name="password"');
  });

  it('a pre-login session (from visiting /login) does not open the UI', async () => {
    const b = browser();
    const page = await b.go('/login');
    expect(b.cookie()).toMatch(/^budd_session=/);
    expect((await b.go('/ui')).res.status).toBe(302);
    const r = await b.go('/ui/connections/claude-code/block', { _csrf: b.csrf(page.body) });
    expect(r.res.status).toBe(403);
    const sse = await fetch(`${budd.url}/ui/events`, { headers: { cookie: b.cookie() } });
    expect(sse.status).toBe(401);
  });

  it('refuses a wrong username or password, and accepts the right ones', async () => {
    const attempt = async (username: string, password: string) => {
      const b = browser();
      const page = await b.go('/login?return=/ui/audit');
      return b.go('/login', { _csrf: b.csrf(page.body), return: '/ui/audit', username, password });
    };
    const wrong = await attempt('alice', 'wrong password');
    expect(wrong.res.status).toBe(401);
    expect(wrong.body).toContain('value="alice"');
    expect((await attempt('someone', 'correct horse')).res.status).toBe(401);
    const ok = await attempt('alice', 'correct horse');
    expect(ok.res.status).toBe(303);
    expect(ok.res.headers.get('location')).toBe('/ui/audit');
  });

  it('limits sign-in attempts', async () => {
    const b = browser();
    const page = await b.go('/login');
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await b.go('/login', {
        _csrf: b.csrf(page.body),
        username: 'alice',
        password: `guess-${String(i)}`,
      });
      statuses.push(r.res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('starts a fresh session at sign-in, and signing out ends it', async () => {
    const b = browser();
    const page = await b.go('/login');
    const before = b.cookie();
    await b.go('/login', {
      _csrf: b.csrf(page.body),
      username: 'alice',
      password: 'correct horse',
    });
    expect(b.cookie()).not.toBe(before);
    const ui = await b.go('/ui');
    expect(ui.res.status).toBe(200);
    await b.go('/logout', { _csrf: b.csrf(ui.body) });
    expect((await b.go('/ui')).res.status).toBe(302);
  });

  it('MCP is unaffected: agents still connect by URL with no login', async () => {
    const agent = await budd.connect('claude-code');
    expect((await agent.ok('whoami')).connection).toBe('claude-code');
  });
});

describe('budd login, connections and block', () => {
  it('a login link gets past the password limit, once, while Budd runs', async () => {
    await setUp();
    const locked = browser();
    const page = await locked.go('/login');
    for (let i = 0; i < 11; i++) {
      await locked.go('/login', { _csrf: locked.csrf(page.body), username: 'x', password: 'y' });
    }
    const refused = await locked.go('/login', {
      _csrf: locked.csrf(page.body),
      username: 'alice',
      password: 'correct horse',
    });
    expect(refused.res.status).toBe(429);
    expect(refused.body).toContain('npm run budd -- login');

    const code = (await createLoginLink(budd.dataDir, budd.clock.now)) ?? '';
    const b = browser();
    const linkPage = await b.go(`/login/link?code=${code}`);
    expect(linkPage.res.status).toBe(200); // opening it uses nothing up
    const signedIn = await b.go('/login/link', { _csrf: b.csrf(linkPage.body), code });
    expect(signedIn.res.status).toBe(303);
    expect((await b.go('/ui')).res.status).toBe(200);
    const again = browser();
    const againPage = await again.go(`/login/link?code=${code}`);
    const reused = await again.go('/login/link', { _csrf: again.csrf(againPage.body), code });
    expect(reused.res.status).toBe(400); // used up
  });

  it('a login link expires after 10 minutes, and there is none without a UI login', async () => {
    expect(await createLoginLink(budd.dataDir, budd.clock.now)).toBeUndefined();
    await setUp();
    const code = (await createLoginLink(budd.dataDir, budd.clock.now)) ?? '';
    budd.clock.now += 10 * 60_000;
    const b = browser();
    const page = await b.go(`/login/link?code=${code}`);
    const r = await b.go('/login/link', { _csrf: b.csrf(page.body), code });
    expect(r.res.status).toBe(400);
    expect(r.body).toContain('Sign-in link not valid');
  });

  it('lists connections and blocks one while Budd runs', async () => {
    const agent = await budd.connect('claude-code');
    await agent.ok('claim_handle', { handle: 'reviewer' });
    const rows = await listConnectionsOffline(budd.dataDir, 'local');
    expect(rows).toEqual([
      expect.objectContaining({ slug: 'claude-code', status: 'active', handles: ['reviewer'] }),
    ]);
    expect(await blockConnectionOffline(budd.dataDir, 'local', 'claude-code')).toBe('blocked');
    expect(await blockConnectionOffline(budd.dataDir, 'local', 'claude-code')).toBe(
      'already_blocked',
    );
    expect(await blockConnectionOffline(budd.dataDir, 'local', 'nope')).toBe('unknown_connection');
    expect(await blockConnectionOffline(budd.dataDir, 'nope', 'x')).toBe('unknown_workspace');
    // The running server sees it at once.
    await expect(agent.call('whoami')).rejects.toThrow(/has been blocked/);
    expect((await budd.audit()).map((e) => e.event)).toContain('connection_blocked');
  });
});

describe('reset-login', () => {
  it('refuses while Budd runs, then forgets the login, so the next start offers setup again', async () => {
    await setUp();
    expect(() => resetLocalLogin(budd.dataDir)).toThrow(DataDirInUseError);
    await budd.internals.storage.close(); // "stop Budd"
    expect(resetLocalLogin(budd.dataDir)).toBe(true);
    expect(resetLocalLogin(budd.dataDir)).toBe(false);
    const storage = testStorage(budd.dataDir);
    await storage.init();
    try {
      const next = new LocalLoginState();
      await next.init(storage.auth);
      expect(next.setupCode).toBeDefined();
    } finally {
      await storage.close();
    }
  });

  it('runs from the CLI, and says to stop Budd first', async () => {
    await setUp();
    const cli = () =>
      promisify(execFile)('npx', ['tsx', path.resolve('src/cli.ts'), 'reset-login'], {
        env: { ...process.env, DATA_DIR: budd.dataDir },
      });
    const running = await cli().catch((e: unknown) => e as { stderr: string });
    expect(running.stderr).toMatch(/Budd is running .* Stop it first/);
    await budd.internals.storage.close();
    const { stdout } = await cli();
    expect(stdout).toMatch(/The UI login was removed/);
  }, 30_000);
});
