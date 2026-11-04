import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startupHint } from '../src/main.js';
import { startServer } from '../src/server.js';
import { DataDirInUseError } from '../src/storage/sqlite/dataDirLock.js';
import { startTestBudd, type TestBudd } from './helpers/harness.js';
import {
  Browser,
  connectClient,
  field,
  startHostedBudd,
  type HostedBudd,
} from './helpers/hosted.js';

const run = promisify(execFile);

/** `budd <args>` against a data directory, as an operator would run it. */
async function cli(dataDir: string, ...args: string[]) {
  return run(path.resolve('node_modules/.bin/tsx'), ['src/cli.ts', ...args], {
    env: { ...process.env, DATA_DIR: dataDir },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: unknown) => err as { code: number; stdout: string; stderr: string },
  );
}

function control(dataDir: string) {
  const db = new Database(path.join(dataDir, 'control.db'), { readonly: true });
  return {
    workspaceId: (slug: string) =>
      (
        db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug) as
          { id: string } | undefined
      )?.id,
    count: (sql: string, ...params: unknown[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n,
    close: () => db.close(),
  };
}

const workspaceFile = (dataDir: string, id: string) => path.join(dataDir, 'workspaces', `${id}.db`);

let budd: TestBudd | HostedBudd | undefined;
afterEach(async () => {
  await budd?.close();
  budd = undefined;
});

describe('budd erase-workspace', () => {
  // Runs the CLI twice: slow on a cold machine.
  it(
    'refuses while Budd runs, then erases one workspace and its account once stopped',
    { timeout: 20_000 },
    async () => {
      const hosted = await startHostedBudd();
      budd = hosted;
      const alice = new Browser(hosted);
      await alice.signIn({ sub: 'a', email: 'alice@example.com' });
      await connectClient(hosted, alice);
      const bob = new Browser(hosted);
      await bob.signIn({ sub: 'b', email: 'bob@example.com' });
      const before = control(hosted.dataDir);
      const aliceWs = before.workspaceId('alice') ?? '';
      before.close();
      expect(fs.existsSync(workspaceFile(hosted.dataDir, aliceWs))).toBe(true);

      const running = await cli(hosted.dataDir, 'erase-workspace', 'alice');
      expect(running.code).toBe(1);
      expect(running.stderr).toMatch(/Budd is running .* Stop it first/);
      expect(fs.existsSync(workspaceFile(hosted.dataDir, aliceWs))).toBe(true);

      // "Stop Budd": release its databases (and its claim on the data directory).
      await hosted.internals.storage.close();
      const erased = await cli(hosted.dataDir, 'erase-workspace', 'alice');
      expect(erased.code).toBe(0);
      expect(erased.stdout).toMatch(/Erased workspace alice .* alice@example\.com/);
      expect(erased.stdout).toMatch(/Backups taken before now still contain it/);

      const after = control(hosted.dataDir);
      expect(after.count('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', aliceWs)).toBe(0);
      expect(
        after.count('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?', aliceWs),
      ).toBe(0);
      expect(
        after.count('SELECT COUNT(*) AS n FROM oauth_grants WHERE workspace_id = ?', aliceWs),
      ).toBe(0);
      expect(after.count('SELECT COUNT(*) AS n FROM oauth_tokens')).toBe(0);
      expect(
        after.count("SELECT COUNT(*) AS n FROM accounts WHERE email = 'alice@example.com'"),
      ).toBe(0);
      expect(
        after.count("SELECT COUNT(*) AS n FROM accounts WHERE email = 'bob@example.com'"),
      ).toBe(1);
      expect(after.workspaceId('bob')).toBeDefined();
      after.close();
      for (const ext of ['', '-wal', '-shm']) {
        expect(fs.existsSync(workspaceFile(hosted.dataDir, aliceWs) + ext)).toBe(false);
      }
    },
  );

  it('says what to do for an unknown workspace, a missing name, or no data', async () => {
    budd = await startTestBudd();
    await budd.internals.storage.close();
    const unknown = await cli(budd.dataDir, 'erase-workspace', 'nobody');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No workspace named nobody .*budd accounts/);
    const missing = await cli(budd.dataDir, 'erase-workspace');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/Name one workspace to erase/);
    const noData = await cli(path.join(budd.dataDir, 'nothing-here'), 'erase-workspace', 'x');
    expect(noData.code).toBe(1);
    expect(noData.stderr).toMatch(/No Budd data found/);
  }, 15_000); // it starts the CLI several times
});

describe('the data directory claim', () => {
  it('stops a second Budd from using the same data directory, with a clear message', async () => {
    budd = await startTestBudd();
    const config = loadConfig({ DATA_DIR: budd.dataDir, PORT: '0' });
    const second = await startServer(config, { quiet: true }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(DataDirInUseError);
    expect(startupHint(second, config)).toMatch(/another Budd.*is using its data directory/);
  });

  it('is released when Budd stops, and when startup fails after taking it', async () => {
    budd = await startTestBudd();
    const { dataDir } = budd;
    await budd.internals.storage.close();
    const busyPort = budd.config.port === 0 ? new URL(budd.url).port : String(budd.config.port);
    // Same port as the running listener: startup fails at listen, after the claim.
    const clash = loadConfig({ DATA_DIR: dataDir, PORT: busyPort });
    await expect(startServer(clash, { quiet: true })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    const again = await startServer(loadConfig({ DATA_DIR: dataDir, PORT: '0' }), { quiet: true });
    await again.close();
  });
});

/** Signs in and connects an app; returns what the tests need to check afterwards. */
async function aliceWithApp(hosted: HostedBudd) {
  const alice = new Browser(hosted);
  await alice.signIn({ sub: 'a', email: 'alice@example.com' });
  const app = await connectClient(hosted, alice);
  const db = control(hosted.dataDir);
  const workspaceId = db.workspaceId('alice') ?? '';
  db.close();
  return { alice, access: app.access, workspaceId };
}

const mcpStatus = async (hosted: HostedBudd, access: string) =>
  (
    await fetch(`${hosted.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  ).status;

/** Steps 1 and 2 in the browser, up to the provider's answer. */
async function eraseInBrowser(browser: Browser, name: string) {
  const page = await browser.go('/ui/erase');
  const step2 = await browser.post('/ui/erase', [
    ['_csrf', field(page.body, '_csrf')],
    ['confirm', name],
  ]);
  if (step2.status !== 200) return step2;
  return browser.post('/ui/erase/reauth', [
    ['_csrf', field(step2.body, '_csrf')],
    ['nonce', field(step2.body, 'nonce')],
  ]);
}

describe('deleting a workspace in the UI (hosted mode)', () => {
  it('after the name and a fresh sign-in, erases it, signs everything out, and starts afresh', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    const { alice, access, workspaceId } = await aliceWithApp(hosted);
    const bob = new Browser(hosted);
    await bob.signIn({ sub: 'b', email: 'bob@example.com' });
    const otherTab = new Browser(hosted);
    await otherTab.signIn({ sub: 'a', email: 'alice@example.com' });
    expect(await mcpStatus(hosted, access)).toBe(200);

    const page = await alice.go('/ui/erase');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<code>claude</code>');
    expect(page.body).toContain('Backups taken before now still contain this workspace');

    const done = await eraseInBrowser(alice, 'alice');
    expect(done.status).toBe(200);
    expect(done.body).toContain('Workspace deleted');
    // Standard OIDC only: max_age=0, and no prompt=login unless the provider lists it.
    expect(hosted.idp.lastAuthorize?.max_age).toBe('0');
    expect(hosted.idp.lastAuthorize?.prompt).toBeUndefined();

    expect(fs.existsSync(workspaceFile(hosted.dataDir, workspaceId))).toBe(false);
    expect(await mcpStatus(hosted, access)).toBe(401);
    expect(alice.cookies.size).toBe(0); // the session cookie was cleared
    // The account's other sessions ended too: the old cookie is sent to sign in.
    const cookie = [...otherTab.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const stale = await fetch(`${hosted.url}/ui`, { redirect: 'manual', headers: { cookie } });
    expect(stale.status).toBe(302);
    expect(stale.headers.get('location')).toMatch(/^\/login/);
    expect((await bob.go('/ui')).body).toContain('<a class="name" href="/ui">bob</a>');

    const again = await alice.signIn({ sub: 'a', email: 'alice@example.com' });
    expect(again.body).toContain('<a class="name" href="/ui">alice</a>');
    const db = control(hosted.dataDir);
    expect(db.workspaceId('alice')).not.toBe(workspaceId);
    db.close();
  });

  it('works with a provider that reports auth_time only when it is claimed, like Google', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    hosted.idp.authTimeOnlyViaClaims = true;
    const { alice } = await aliceWithApp(hosted);
    expect((await eraseInBrowser(alice, 'alice')).body).toContain('Workspace deleted');
    expect(JSON.parse(hosted.idp.lastAuthorize?.claims ?? '{}')).toEqual({
      id_token: { auth_time: { essential: true } },
    });
  });

  it('asks for prompt=login when the provider supports it', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    hosted.idp.promptValues = ['none', 'login', 'consent'];
    const { alice } = await aliceWithApp(hosted);
    expect((await eraseInBrowser(alice, 'alice')).body).toContain('Workspace deleted');
    expect(hosted.idp.lastAuthorize?.prompt).toBe('login');
  });

  it('deletes nothing when the provider skipped signing in again', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    const { alice, access, workspaceId } = await aliceWithApp(hosted);
    for (const tamper of ['stale-auth-time', 'no-auth-time'] as const) {
      hosted.idp.tamper = tamper;
      const page = await eraseInBrowser(alice, 'alice');
      expect(page.status).toBe(403);
      expect(page.body).toContain('Sign out at your provider');
      expect(page.body).toContain('Nothing was deleted');
    }
    expect(fs.existsSync(workspaceFile(hosted.dataDir, workspaceId))).toBe(true);
    expect(await mcpStatus(hosted, access)).toBe(200);
  });

  it('deletes nothing when someone else signs in at the provider', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    const { alice, workspaceId } = await aliceWithApp(hosted);
    const page = await alice.go('/ui/erase');
    const step2 = await alice.post('/ui/erase', [
      ['_csrf', field(page.body, '_csrf')],
      ['confirm', 'alice'],
    ]);
    hosted.idp.user = { sub: 'mallory', email: 'mallory@example.com' };
    const result = await alice.post('/ui/erase/reauth', [
      ['_csrf', field(step2.body, '_csrf')],
      ['nonce', field(step2.body, 'nonce')],
    ]);
    expect(result.status).toBe(403);
    expect(result.body).toContain('different account');
    expect(fs.existsSync(workspaceFile(hosted.dataDir, workspaceId))).toBe(true);
  });

  it('refuses a wrong name, a reused or missing nonce, and a forged form', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    const { alice, workspaceId } = await aliceWithApp(hosted);
    const page = await alice.go('/ui/erase');
    const csrf = field(page.body, '_csrf');

    const wrong = await alice.post('/ui/erase', [
      ['_csrf', csrf],
      ['confirm', 'Alice'],
    ]);
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain('Nothing was deleted');

    const noNonce = await alice.post('/ui/erase/reauth', [['_csrf', csrf]]);
    expect(noNonce.url).toMatch(/\/ui\/erase\?error=confirm_failed$/);
    expect(noNonce.body).toContain('no longer valid');

    const forged = await alice.post('/ui/erase', [
      ['_csrf', 'not-the-token'],
      ['confirm', 'alice'],
    ]);
    expect(forged.status).toBe(403);
    const crossSite = await alice.go('/ui/erase', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ _csrf: csrf, confirm: 'alice' }).toString(),
    });
    expect(crossSite.status).toBe(403);

    // A nonce works once: replaying step 2's form after it was used fails.
    const step2 = await alice.post('/ui/erase', [
      ['_csrf', csrf],
      ['confirm', 'alice'],
    ]);
    const nonce = field(step2.body, 'nonce');
    hosted.idp.tamper = 'stale-auth-time'; // the first attempt is refused at the callback
    await alice.post('/ui/erase/reauth', [
      ['_csrf', csrf],
      ['nonce', nonce],
    ]);
    hosted.idp.tamper = undefined;
    const replay = await alice.post('/ui/erase/reauth', [
      ['_csrf', csrf],
      ['nonce', nonce],
    ]);
    expect(replay.url).toMatch(/error=confirm_failed$/);
    expect(fs.existsSync(workspaceFile(hosted.dataDir, workspaceId))).toBe(true);
  });

  it('signed-out visitors are sent to sign in, and the sign-in step is refused', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    const res = await fetch(`${hosted.url}/ui/erase`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/login/);
    const reauth = await fetch(`${hosted.url}/ui/erase/reauth`, { method: 'POST' });
    expect(reauth.status).toBe(403);
    expect(reauth.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

/** A browser for local mode: one cookie, and forms posted with the page's CSRF token. */
async function localBrowser(local: TestBudd) {
  let cookie = await local.uiCookie();
  const go = async (p: string, form?: Record<string, string>) => {
    const res = await fetch(`${local.url}${p}`, {
      redirect: 'manual',
      ...(form && {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams(form).toString(),
      }),
      ...(!form && { headers: { cookie } }),
    });
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };
  return {
    go,
    setCookie: (c: string) => {
      cookie = c;
    },
  };
}

describe('deleting the workspace in the UI (local mode)', () => {
  it('needs the name and the password, then starts a new workspace with a new setup link', async () => {
    const local = await startTestBudd();
    budd = local;
    const agent = await local.connect('claude-code');
    await agent.ok('whoami');
    const oldId = local.adminCtx.workspace.id;
    expect(fs.existsSync(workspaceFile(local.dataDir, oldId))).toBe(true);
    const b = await localBrowser(local);

    const page = await b.go('/ui/erase');
    expect(page.body).toContain('<code>claude-code</code>');
    expect(page.body).toContain('the UI login');
    const csrf = field(page.body, '_csrf');
    const step2 = await b.go('/ui/erase', { _csrf: csrf, confirm: 'local' });
    expect(step2.body).toContain('enter your Budd password');

    const wrong = await b.go('/ui/erase/confirm', {
      _csrf: csrf,
      nonce: field(step2.body, 'nonce'),
      password: 'not-it',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('Nothing was deleted.');
    expect(wrong.body).toContain('Wrong password.');
    expect(fs.existsSync(workspaceFile(local.dataDir, oldId))).toBe(true);

    const done = await b.go('/ui/erase/confirm', {
      _csrf: csrf,
      nonce: field(wrong.body, 'nonce'),
      password: 'test-password-1',
    });
    expect(done.status).toBe(200);
    expect(done.body).toContain('Workspace deleted');
    expect(fs.existsSync(workspaceFile(local.dataDir, oldId))).toBe(false);

    // The old session is gone, and the new setup link works.
    expect((await b.go('/ui')).location).toMatch(/^\/login/);
    const setup = /href="(\/setup\?code=[^"]+)"|href="https?:\/\/[^/]+(\/setup\?code=[^"]+)"/.exec(
      done.body,
    );
    const setupPath = setup?.[1] ?? setup?.[2] ?? '';
    expect((await fetch(`${local.url}${setupPath}`)).status).toBe(200);

    const db = control(local.dataDir);
    const newId = db.workspaceId('local');
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(db.count('SELECT COUNT(*) AS n FROM local_logins')).toBe(0);
    db.close();
    // An app using its MCP URL again joins the new workspace as a new connection.
    const back = await local.connect('claude-code');
    await back.ok('whoami');
    expect(fs.existsSync(workspaceFile(local.dataDir, newId ?? ''))).toBe(true);
  });

  it('limits password guesses', async () => {
    const local = await startTestBudd();
    budd = local;
    const b = await localBrowser(local);
    const csrf = field((await b.go('/ui/erase')).body, '_csrf');
    let page = await b.go('/ui/erase', { _csrf: csrf, confirm: 'local' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      page = await b.go('/ui/erase/confirm', {
        _csrf: csrf,
        nonce: field(page.body, 'nonce'),
        password: `guess-${String(i)}`,
      });
      statuses.push(page.status);
    }
    // Shared with the sign-in page, where signing in used one attempt.
    expect(statuses.indexOf(429)).toBe(9);
    expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
  });

  it('refuses an expired confirmation without deleting anything', async () => {
    const local = await startTestBudd();
    budd = local;
    const b = await localBrowser(local);
    const csrf = field((await b.go('/ui/erase')).body, '_csrf');
    const step2 = await b.go('/ui/erase', { _csrf: csrf, confirm: 'local' });
    local.clock.now += 6 * 60_000;
    const late = await b.go('/ui/erase/confirm', {
      _csrf: csrf,
      nonce: field(step2.body, 'nonce'),
      password: 'test-password-1',
    });
    expect(late.status).toBe(400);
    expect(late.body).toContain('no longer valid');
    expect(fs.existsSync(workspaceFile(local.dataDir, local.adminCtx.workspace.id))).toBe(true);
  });
});

it('an erased workspace is never reopened, and the sweeper skips it', async () => {
  const hosted = await startHostedBudd();
  budd = hosted;
  const { alice, workspaceId } = await aliceWithApp(hosted);
  await eraseInBrowser(alice, 'alice');
  await expect(hosted.internals.storage.openWorkspace(workspaceId)).rejects.toThrow(/no workspace/);
  await hosted.sweep();
  expect(fs.existsSync(workspaceFile(hosted.dataDir, workspaceId))).toBe(false);
});

it('leaves no trace of the erased account in the control database files', async () => {
  const hosted = await startHostedBudd();
  budd = hosted;
  const { alice } = await aliceWithApp(hosted);
  await eraseInBrowser(alice, 'alice');
  for (const ext of ['', '-wal']) {
    const file = path.join(hosted.dataDir, `control.db${ext}`);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    expect(bytes.includes('alice@example.com')).toBe(false);
  }
});

it('budd erase-workspace refuses data from another version of Budd', async () => {
  budd = await startTestBudd();
  await budd.internals.storage.close();
  const db = new Database(path.join(budd.dataDir, 'control.db'));
  db.pragma('user_version = 1');
  db.close();
  const old = await cli(budd.dataDir, 'erase-workspace', 'local');
  expect(old.code).toBe(1);
  expect(old.stderr).toMatch(/predates this version of Budd. Start \(or restart\) this version/);
});
