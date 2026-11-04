import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus/Bus.js';
import { loadConfig } from '../src/config.js';
import { WorkspaceGateway, type ConnectionContext } from '../src/storage/gateway.js';
import { SqliteStorage } from '../src/storage/sqlite/SqliteStorage.js';
import { testStorage } from './helpers/harness.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
let dir: string;
let storage: SqliteStorage;
let gateway: WorkspaceGateway;
let bus: Bus;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-gw-'));
  storage = testStorage(dir);
  await storage.init();
  gateway = new WorkspaceGateway(storage);
  bus = new Bus(gateway, loadConfig({ DATA_DIR: dir }), () => NOW);
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace gateway isolation', () => {
  it('stores each workspace in its own file', async () => {
    const local = await storage.control.ensureLocalWorkspace(NOW);
    const other = await storage.control.createWorkspaceForAccount({
      email: 'a@example.com',
      slugBase: 'alice',
      now: NOW,
    });
    await gateway.connectLocal('claude-desktop', NOW);
    await storage.openWorkspace(other.id);
    const files = fs.readdirSync(path.join(dir, 'workspaces')).filter((f) => f.endsWith('.db'));
    expect(files.sort()).toEqual([`${local.id}.db`, `${other.id}.db`].sort());
  });

  it('keeps one workspace’s data out of another', async () => {
    const other = await storage.control.createWorkspaceForAccount({
      email: 'b@example.com',
      slugBase: 'other',
      now: NOW,
    });
    const a = await gateway.connectLocal('claude-desktop', NOW);
    const b = await gateway.connectLocal('grok-build', NOW);
    await bus.inboxCount(b, { handle: 'researcher' });
    await bus.send(a, { to: ['grok-build/researcher'], from_handle: 'cos', body_md: 'secret' });

    const otherStore = await storage.openWorkspace(other.id);
    expect(await otherStore.listConnections()).toEqual([]);
    expect(await otherStore.listHandles()).toEqual([]);

    // Addressing the other workspace explicitly is refused.
    const res = await bus.send(a, {
      to: ['other/grok-build/researcher'],
      from_handle: 'cos',
      body_md: 'x',
    });
    expect(res.results[0]).toMatchObject({ status: 'rejected', reason: 'cross_workspace' });
  });

  it('refuses contexts it did not issue, including ones pointing at another workspace', async () => {
    const other = await storage.control.createWorkspaceForAccount({
      email: 'c@example.com',
      slugBase: 'other',
      now: NOW,
    });
    const real = await gateway.connectLocal('claude-desktop', NOW);
    const forged: ConnectionContext = { workspace: other, connection: real.connection };
    await expect(gateway.forConnection(forged)).rejects.toThrow(/not issued by the gateway/);
    await expect(bus.inbox(forged, { handle: 'x1' })).rejects.toThrow(/not issued/);
    const copy: ConnectionContext = { ...real };
    await expect(gateway.forConnection(copy)).rejects.toThrow(/not issued/);
    // Issued contexts are frozen, so they cannot be re-pointed.
    expect(() => {
      (real as { workspace: unknown }).workspace = other;
    }).toThrow();
  });

  it('suffixes colliding workspace slugs', async () => {
    const w1 = await storage.control.createWorkspaceForAccount({
      email: 'x@a.com',
      slugBase: 'alice',
      now: NOW,
    });
    const w2 = await storage.control.createWorkspaceForAccount({
      email: 'y@b.com',
      slugBase: 'Alice',
      now: NOW,
    });
    expect([w1.slug, w2.slug]).toEqual(['alice', 'alice-2']);
  });
});

describe('architecture', () => {
  const srcFiles = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
  const root = path.resolve(import.meta.dirname, '..', 'src');

  it('only the gateway opens workspace databases', () => {
    const callers = srcFiles(root)
      .filter((f) => /\.openWorkspace\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(callers).toEqual([path.join('storage', 'gateway.ts')]);
  });

  it('only the gateway erases workspaces from storage', () => {
    const callers = srcFiles(root)
      .filter((f) => /storage\.eraseWorkspace\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(callers).toEqual([path.join('storage', 'gateway.ts')]);
  });

  it('nothing agent-facing can reach the admin service', () => {
    const agentFacing = srcFiles(root).filter(
      (f) =>
        f.includes(`${path.sep}mcp${path.sep}`) ||
        f.includes(`${path.sep}bus${path.sep}`) ||
        f.endsWith('mcpRoute.ts'),
    );
    const offenders = agentFacing
      .filter((f) =>
        /admin\/Admin|adminLocal|forAdmin|eraseWorkspace|policy_widened|setConnectionStatus|setConnectionArchived|setConnectionLabel|setHandleArchived|WakeUp|wakeups\/|workspaceSecretKey/.test(
          fs.readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('no SQL or better-sqlite3 outside the SQLite adapter', () => {
    const offenders = srcFiles(root)
      .filter((f) => !f.includes(`${path.sep}storage${path.sep}sqlite${path.sep}`))
      .filter((f) =>
        /better-sqlite3|\b(SELECT|INSERT|UPDATE|DELETE)\s/.test(fs.readFileSync(f, 'utf8')),
      )
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
