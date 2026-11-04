import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminError } from '../src/admin/Admin.js';
import type { ConnectionKeys } from '../src/admin/keys.js';
import { hashToken } from '../src/auth/tokens.js';
import type { AdminContext } from '../src/storage/gateway.js';
import {
  authorizeUrl,
  Browser,
  connectClient,
  field,
  mcpAs,
  pkce,
  rawMcp,
  register,
  startHostedBudd,
  type HostedBudd,
} from './helpers/hosted.js';

/** API-key connections (ADR 0016). */

let budd: HostedBudd;
let keys: ConnectionKeys;
let ctx: AdminContext;
let accountId: string;
const alice = { sub: 'alice-sub', email: 'alice@example.com' };

beforeEach(async () => {
  budd = await startHostedBudd();
  if (!budd.internals.keys) throw new Error('hosted mode has keys');
  keys = budd.internals.keys;
  const { account, workspaces } = await budd.internals.storage.auth.signIn({
    issuer: budd.idp.issuer,
    subject: alice.sub,
    email: alice.email,
    slugBase: 'alice',
    now: budd.clock.now,
  });
  accountId = account.id;
  ctx = await budd.internals.gateway.adminForAccount(account.id, workspaces[0]?.id ?? '');
});
afterEach(async () => {
  await budd.close();
});

const auditOf = async (event: string) =>
  (await budd.admin.audit(ctx, 100)).filter((e) => e.event === event);

describe('creating a key connection', () => {
  it('gives a budd_key_ key that works as a bearer token, once', async () => {
    const { connection, key } = await keys.create(ctx, accountId, {
      name: 'nightly-ci',
      label: 'CI on the build box',
    });
    expect(connection).toMatchObject({
      slug: 'nightly-ci',
      kind: 'key',
      label: 'CI on the build box',
    });
    expect(key).toMatch(/^budd_key_[A-Za-z0-9_-]{43}$/);
    const agent = await mcpAs(budd, key);
    expect(await agent.ok('whoami')).toMatchObject({
      connection: 'nightly-ci',
      connection_verified: true,
    });
    await agent.close();
    // Stored hashed only: the control database holds its SHA-256, never the key.
    const db = new Database(path.join(budd.dataDir, 'control.db'), { readonly: true });
    const rows = db.prepare('SELECT * FROM connection_keys').all();
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key.slice('budd_key_'.length));
    expect(rows[0]).toMatchObject({ key_hash: hashToken(key), revoked_at: null });
    const current = await keys.current(ctx, connection);
    expect(current?.hint).toBe(key.slice(-4));
    expect((await auditOf('connection_registered'))[0]?.detail).toMatchObject({
      connection: 'nightly-ci',
      via: 'key',
    });
    expect(await auditOf('key_created')).toHaveLength(1);
  });

  it('is a full principal: contact policies apply as for any connection', async () => {
    const { key: a } = await keys.create(ctx, accountId, { name: 'cron-a', label: '' });
    const { key: b } = await keys.create(ctx, accountId, { name: 'cron-b', label: '' });
    const sender = await mcpAs(budd, a);
    const receiver = await mcpAs(budd, b);
    await receiver.ok('claim_handle', { handle: 'worker' });
    const refused = await sender.ok('send', {
      to: ['cron-b/worker'],
      body_md: 'hi',
      from_handle: 'boss',
    });
    expect(refused.results[0]).toMatchObject({ status: 'rejected', reason: 'policy' });
    await budd.admin.setPolicy(
      ctx,
      'cron-b',
      { mode: 'allowlist', allowed: ['cron-a'] },
      { confirmed: true },
    );
    const sent = await sender.ok('send', {
      to: ['cron-b/worker'],
      body_md: 'hi',
      from_handle: 'boss',
    });
    expect(sent.results[0].status).toBe('delivered');
    expect((await receiver.ok('inbox', { handle: 'worker' })).messages).toHaveLength(1);
    await sender.close();
    await receiver.close();
  });

  it('refuses a bad name, a reserved one, and one already taken (archived included)', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await keys.create(ctx, accountId, { name: 'old-job', label: '' });
    await budd.admin.archive(ctx, 'old-job');
    for (const name of ['No Spaces', 'x', 'budd', 'alice', 'claude', 'old-job']) {
      await expect(keys.create(ctx, accountId, { name, label: '' }), name).rejects.toBeInstanceOf(
        AdminError,
      );
    }
  });
});

describe('rotating and revoking', () => {
  it('rotating issues a new key and the old one stops at once', async () => {
    const { key: first } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    const second = await keys.rotate(ctx, accountId, 'nightly');
    expect(second).not.toBe(first);
    expect((await rawMcp(budd, first)).status).toBe(401);
    expect((await rawMcp(budd, second)).status).toBe(200);
    expect((await auditOf('key_created'))[0]?.detail).toMatchObject({ replaced_key: true });
  });

  it('expires after KEY_IDLE_EXPIRY unused; each use moves the expiry on', async () => {
    const DAY = 86_400_000;
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    budd.clock.now += 29 * DAY;
    expect((await rawMcp(budd, key)).status).toBe(200); // used: 30 more days from now
    budd.clock.now += 29 * DAY;
    expect((await rawMcp(budd, key)).status).toBe(200);
    budd.clock.now += 30 * DAY;
    const res = await rawMcp(budd, key);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await res.text()).toMatch(
      /expired after going unused \(keys stop after 30 days unused\).*mailboxes/,
    );
    // It no longer counts as a way in, and a new key needs no "replace?" step.
    expect(
      await budd.internals.storage.auth.liveConnectionIds(ctx.workspace.id, budd.clock.now),
    ).toEqual([]);
    expect(await keys.hasKey(ctx, 'nightly')).toBe(false);
    expect((await rawMcp(budd, await keys.rotate(ctx, accountId, 'nightly'))).status).toBe(200);
  });

  it('revoking stops the key, says how to get a new one, and is audited', async () => {
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    expect(await keys.revoke(ctx, 'nightly')).toBe(true);
    expect(await keys.revoke(ctx, 'nightly')).toBe(false);
    const res = await rawMcp(budd, key);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await res.text()).toMatch(/unknown or has been revoked.*connection’s page/);
    expect(await auditOf('key_revoked')).toHaveLength(1);
  });

  it('blocking or archiving revokes the key; a new key is needed after unblocking', async () => {
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    await budd.admin.block(ctx, 'nightly');
    expect((await rawMcp(budd, key)).status).toBe(401);
    await budd.admin.unblock(ctx, 'nightly', { confirmed: true });
    expect((await rawMcp(budd, key)).status).toBe(401);
    const fresh = await keys.rotate(ctx, accountId, 'nightly');
    expect((await rawMcp(budd, fresh)).status).toBe(200);
    expect((await auditOf('key_created'))[0]?.detail).toMatchObject({
      key: `budd_key_…${fresh.slice(-4)}`,
      made_by: accountId,
    });
    await budd.admin.archive(ctx, 'nightly');
    expect((await rawMcp(budd, fresh)).status).toBe(401);
    await expect(keys.rotate(ctx, accountId, 'nightly')).rejects.toMatchObject({
      code: 'archived',
    });
  });

  it('a blocked key connection gets no new key until unblocked; blocking audits key_revoked', async () => {
    await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    await budd.admin.block(ctx, 'nightly');
    await expect(keys.rotate(ctx, accountId, 'nightly')).rejects.toMatchObject({ code: 'blocked' });
    expect((await auditOf('key_revoked'))[0]?.detail).toMatchObject({
      reason: 'connection_blocked',
    });
    expect(await auditOf('token_revoked')).toHaveLength(0);
  });

  it('only key connections have keys: an OAuth connection can be neither rotated nor revoked', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await expect(keys.rotate(ctx, accountId, 'claude')).rejects.toMatchObject({
      code: 'unknown_connection',
    });
    await expect(keys.revoke(ctx, 'claude')).rejects.toMatchObject({ code: 'unknown_connection' });
    await expect(keys.revoke(ctx, 'budd')).rejects.toMatchObject({ code: 'unknown_connection' });
  });
});

describe('what a key can and cannot do', () => {
  it('refuses a made-up key, an OAuth token dressed as a key, and keys at /mcp/<name>', async () => {
    expect((await rawMcp(budd, `budd_key_${'A'.repeat(43)}`)).status).toBe(401);
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    expect((await rawMcp(budd, key.replace('budd_key_', 'budd_at_'))).status).toBe(401);
    const named = await fetch(`${budd.url}/mcp/nightly`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(named.status).toBe(404);
  });

  it('stops working when the account that created it leaves the workspace', async () => {
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    await budd.internals.storage.eraseWorkspace(ctx.workspace.id);
    expect((await rawMcp(budd, key)).status).toBe(401);
  });

  it('a key connection is never offered for an app to take over at consent', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    // Blocked, as a human would before handing one over; still never a key connection.
    await budd.admin.block(ctx, 'claude');
    await budd.admin.block(ctx, 'nightly');
    budd.clock.now += 1000;
    const { body: client } = await register(budd, { client_name: 'Claude' });
    const page = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(page.body).toContain('Which connection should it use?');
    expect(page.body).toMatch(/Existing\s*<code>claude<\/code>/);
    expect(page.body).not.toMatch(/Existing\s*<code>nightly<\/code>/);
  });
});

describe('the UI for key connections', () => {
  const csrfOf = (body: string) => field(body, '_csrf');
  const shownKey = (body: string) =>
    /<textarea id="key"[^>]*>(budd_key_[^<]+)<\/textarea>/.exec(body)?.[1];

  it('adds a connection with a key, shown once on a page nobody caches', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const connections = await b.go('/ui');
    expect(connections.body).toContain('href="/ui/new"');
    const form = await b.go('/ui/new');
    expect(form.body).toContain('An agent with an API key');
    const shown = await b.post('/ui/new', [
      ['_csrf', csrfOf(form.body)],
      ['name', 'Nightly-CI'],
      ['label', 'CI box'],
    ]);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    expect(shown.body).not.toContain('data-live');
    const key = shownKey(shown.body);
    expect(key).toMatch(/^budd_key_/);
    expect(shown.body).toContain(`Authorization: Bearer ${key ?? ''}`);
    expect((await rawMcp(budd, key)).status).toBe(200);

    const page = await b.go('/ui/connections/nightly-ci');
    expect(page.body).not.toContain(key ?? 'x');
    expect(page.body).toContain(`budd_key_…${key?.slice(-4) ?? ''}`);
    expect(page.body).toContain(`Made by ${alice.email}`);
    expect((await b.go('/ui?view=table')).body).toMatch(
      /nightly-ci<\/code\s*><\/a\s*> <span class="tag">API key<\/span>/,
    );
  });

  it('keeps what was typed and says why when the name is taken or invalid', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    const form = await b.go('/ui/new');
    for (const name of ['nightly', 'bad name', 'budd']) {
      const r = await b.post('/ui/new', [
        ['_csrf', csrfOf(form.body)],
        ['name', name],
        ['label', 'kept'],
      ]);
      expect(r.status, name).toBe(400);
      expect(r.body, name).toContain('Nothing changed.');
      expect(r.body, name).toContain('aria-invalid="true"');
      expect(r.body, name).toContain('value="kept"');
    }
  });

  it('shows when the key was last used and when it stops; an expired one gets a new key at once', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { key } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    let page = await b.go('/ui/connections/nightly');
    expect(page.body).toMatch(/not used yet/);
    expect(page.body).toContain('stops working');
    await rawMcp(budd, key);
    budd.clock.now += 31 * 86_400_000;
    await b.signIn(alice); // the old session timed out long ago
    page = await b.go('/ui/connections/nightly');
    expect(page.body).toContain('Expired key');
    const shown = await b.post('/ui/connections/nightly/key', [['_csrf', csrfOf(page.body)]]);
    const fresh = shownKey(shown.body);
    expect(fresh).toMatch(/^budd_key_/);
    expect((await rawMcp(budd, fresh)).status).toBe(200);
  });

  it('replacing a key asks first, then the old key stops; revoking leaves "No key"', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    const { key: first } = await keys.create(ctx, accountId, { name: 'nightly', label: '' });
    const page = await b.go('/ui/connections/nightly');
    const dialog = await b.post('/ui/connections/nightly/key', [['_csrf', csrfOf(page.body)]]);
    expect(dialog.body).toContain('Replace the key for <code>nightly</code>?');
    expect(dialog.body).toContain('class="btn danger">Replace the key for nightly</button>');
    expect((await rawMcp(budd, first)).status).toBe(200); // nothing changed yet
    const shown = await b.post('/ui/connections/nightly/key/confirm', [
      ['_csrf', csrfOf(dialog.body)],
      ['nonce', field(dialog.body, 'nonce')],
    ]);
    expect(shown.body).toContain('Replaced the key for nightly.');
    const second = shownKey(shown.body);
    expect((await rawMcp(budd, first)).status).toBe(401);
    expect((await rawMcp(budd, second)).status).toBe(200);
    // The nonce worked once.
    const again = await b.post('/ui/connections/nightly/key/confirm', [
      ['_csrf', csrfOf(dialog.body)],
      ['nonce', field(dialog.body, 'nonce')],
    ]);
    expect(again.body).toContain('That confirmation is no longer valid');

    const revoked = await b.post('/ui/connections/nightly/key/revoke', [
      ['_csrf', csrfOf(page.body)],
    ]);
    expect(revoked.body).toContain('Revoked the key for nightly.');
    expect(revoked.body).toContain('Give nightly a key');
    expect((await rawMcp(budd, second)).status).toBe(401);
    expect((await b.go('/ui?view=table')).body).toMatch(/<div class="muted">No working key<\/div>/);
    const twice = await b.post('/ui/connections/nightly/key/revoke', [
      ['_csrf', csrfOf(page.body)],
    ]);
    expect(twice.body).toContain('It has no key to revoke.');
    // With no key, giving one needs no confirm.
    const given = await b.post('/ui/connections/nightly/key', [['_csrf', csrfOf(page.body)]]);
    expect((await rawMcp(budd, shownKey(given.body))).status).toBe(200);
  });

  it('refuses key actions on an OAuth connection, and a POST without the CSRF token', async () => {
    const b = new Browser(budd);
    await b.signIn(alice);
    await connectClient(budd, b, 'Claude');
    const page = await b.go('/ui/connections/claude');
    expect(page.body).not.toContain('<h2>API key</h2>');
    const r = await b.post('/ui/connections/claude/key', [['_csrf', csrfOf(page.body)]]);
    expect(r.url).toContain('error=unknown_connection');
    const noCsrf = await b.post('/ui/new', [['name', 'sneaky']]);
    expect(noCsrf.status).toBe(403);
    await expect(keys.revoke(ctx, 'sneaky')).rejects.toMatchObject({ code: 'unknown_connection' });
  });
});

describe('connections per workspace', () => {
  it('caps key connections and apps approved at consent alike', async () => {
    await budd.close();
    budd = await startHostedBudd({ MAX_CONNECTIONS_PER_WORKSPACE: '1' });
    const capped = budd.internals.keys;
    if (!capped) throw new Error('hosted mode has keys');
    const b = new Browser(budd);
    await b.signIn(alice);
    const account = await budd.internals.storage.auth.findAccountId(budd.idp.issuer, alice.sub);
    const [workspace] = await budd.internals.storage.auth.listWorkspacesForAccount(account ?? '');
    const capCtx = await budd.internals.gateway.adminForAccount(account ?? '', workspace?.id ?? '');

    await capped.create(capCtx, account ?? '', { name: 'first', label: '' });
    await expect(
      capped.create(capCtx, account ?? '', { name: 'second', label: '' }),
    ).rejects.toThrow(/the most connections it may have/);
    expect((await b.go('/ui/add-agent')).body).toContain('<strong>Workspace full.</strong>');
    // The consent screen says so before anyone approves, and offers only the way back.
    const { body: client } = await register(budd, { client_name: 'Claude' });
    const consent = await b.go(authorizeUrl(client.client_id, pkce().challenge));
    expect(consent.body).toContain('<strong>Workspace full.</strong>');
    expect(consent.body).not.toContain('value="approve"');
    // Approving anyway (a stale page, a crafted form) is still refused.
    await expect(connectClient(budd, b, 'Claude')).rejects.toThrow(/403.*wasn’t connected/s);
  });
});
