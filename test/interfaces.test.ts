import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { InProcessEventBus } from '../src/events/InProcessEventBus.js';
import { TokenBucketRateLimiter } from '../src/ratelimit/TokenBucketRateLimiter.js';
import { controlMigrations } from '../src/storage/sqlite/controlMigrations.js';
import { migrate, SchemaTooNewError } from '../src/storage/sqlite/migrate.js';
import { SqliteStorage } from '../src/storage/sqlite/SqliteStorage.js';
import { testStorage } from './helpers/harness.js';
import { workspaceMigrations } from '../src/storage/sqlite/workspaceMigrations.js';
import { IntervalSweeper } from '../src/sweeper/IntervalSweeper.js';

describe('TokenBucketRateLimiter', () => {
  it('allows `capacity` actions per window, then refills', () => {
    const rl = new TokenBucketRateLimiter(5, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rl.tryConsume('a', t0)).toBe(true);
    expect(rl.tryConsume('a', t0)).toBe(false);
    expect(rl.tryConsume('a', t0 + 11_999)).toBe(false);
    expect(rl.tryConsume('a', t0 + 12_000)).toBe(true); // one token per 12s at 5/min
  });

  it('keeps keys independent', () => {
    const rl = new TokenBucketRateLimiter(1, 60_000);
    expect(rl.tryConsume('a', 0)).toBe(true);
    expect(rl.tryConsume('a', 0)).toBe(false);
    expect(rl.tryConsume('b', 0)).toBe(true);
  });
});

describe('InProcessEventBus', () => {
  it('delivers only to subscribers of the same workspace', () => {
    const bus = new InProcessEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = bus.subscribe('ws-a', a);
    bus.subscribe('ws-b', b);
    const event = { kind: 'send', at: new Date(0).toISOString(), data: {} };
    bus.publish('ws-a', event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).not.toHaveBeenCalled();
    unsubscribe();
    bus.publish('ws-a', event);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener', () => {
    const bus = new InProcessEventBus();
    const ok = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.subscribe('ws', () => {
      throw new Error('boom');
    });
    bus.subscribe('ws', ok);
    bus.publish('ws', { kind: 'x', at: '', data: {} });
    expect(ok).toHaveBeenCalled();
  });
});

describe('IntervalSweeper', () => {
  it('runs every job once and survives a failing job', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sweeper = new IntervalSweeper(60_000);
    const order: string[] = [];
    sweeper.register({
      name: 'fails',
      run: () => Promise.reject(new Error('nope')),
    });
    sweeper.register({
      name: 'works',
      run: (now) => {
        order.push(now.toISOString());
        return Promise.resolve();
      },
    });
    await sweeper.runOnce(new Date(0));
    expect(order).toEqual([new Date(0).toISOString()]);
  });
});

describe('migrate', () => {
  it('applies pending migrations once and records user_version', () => {
    const db = new Database(':memory:');
    const migrations = [
      { version: 1, up: 'CREATE TABLE a (x)' },
      { version: 2, up: 'CREATE TABLE b (y)' },
    ];
    migrate(db, migrations.slice(0, 1));
    migrate(db, migrations);
    migrate(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()).toEqual({
      n: 2,
    });
  });

  it('gives API keys made before key expiry a full KEY_IDLE_EXPIRY from the upgrade', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-keys-'));
    const db = new Database(path.join(dataDir, 'control.db'));
    migrate(db, controlMigrations.slice(0, 5));
    db.exec(`INSERT INTO accounts (id, created_at) VALUES ('a', 0);
             INSERT INTO workspaces (id, slug, created_at) VALUES ('w', 'w', 0);
             INSERT INTO connection_keys (key_hash, workspace_id, connection_id, account_id, key_hint, created_at)
               VALUES ('h', 'w', 'c', 'a', 'abcd', 0);`);
    db.close();
    const week = 7 * 86_400_000;
    const before = Date.now();
    const storage = new SqliteStorage(
      dataDir,
      { maxConnections: 50, maxWorkspaceBytes: 1024, maxAuditBytes: 1024, rotateAudit: false },
      week,
    );
    await storage.init();
    await storage.close();
    const after = new Database(path.join(dataDir, 'control.db'));
    const { expires_at } = after.prepare('SELECT expires_at FROM connection_keys').get() as {
      expires_at: number;
    };
    after.close();
    expect(expires_at).toBeGreaterThanOrEqual(before + week);
    expect(expires_at).toBeLessThanOrEqual(Date.now() + week);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('upgrades a Phase 1 workspace DB: existing connections get the deny-all default policy', () => {
    const db = new Database(':memory:');
    migrate(db, workspaceMigrations.slice(0, 1));
    db.prepare(
      "INSERT INTO connections (id, slug, created_at) VALUES ('01JA0000000000000000000000', 'grok-build', 0)",
    ).run();
    migrate(db, workspaceMigrations);
    expect(db.prepare('SELECT slug, policy_mode FROM connections').all()).toEqual([
      { slug: 'grok-build', policy_mode: 'allowlist' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM policy_allowed').get()).toEqual({ n: 0 });
  });

  it('counts what messages and audit entries take up, from before the quotas and as rows come and go', () => {
    const db = new Database(':memory:');
    migrate(db, workspaceMigrations.slice(0, 5));
    db.prepare(
      "INSERT INTO connections (id, slug, created_at) VALUES ('01JA0000000000000000000000', 'grok-build', 0)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO messages (id, type, from_connection_id, to_json, subject, body_md, payload_json, thread_id, created_at, expires_at)
       VALUES (?, 'message', '01JA0000000000000000000000', '[]', ?, ?, ?, ?, 0, 0)`,
    );
    const audit = db.prepare(
      "INSERT INTO audit (at, event, actor, detail_json) VALUES (0, 'send', 'agent', ?)",
    );
    insert.run('m1', null, 'héllo', null, 'm1'); // 256 + 2 ('[]') + 6
    audit.run('{}'); // 64 + 4 ('send') + 2
    migrate(db, workspaceMigrations);
    const stored = () => db.prepare('SELECT messages, audit FROM stored_bytes').get();
    expect(stored()).toEqual({ messages: 264, audit: 70 });
    insert.run('m2', 'hi', null, '{"a":1}', 'm2'); // 256 + 2 + 2 + 7
    audit.run('{"x":1}');
    expect(stored()).toEqual({ messages: 531, audit: 145 });
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
    db.prepare('DELETE FROM audit WHERE id = 1').run();
    expect(stored()).toEqual({ messages: 267, audit: 75 });
    expect(() => db.prepare("UPDATE messages SET body_md = 'x' WHERE id = 'm2'").run()).toThrow(
      /not edited/,
    );
  });

  it('refuses a database written by a newer Budd (no silent downgrade)', () => {
    const db = new Database(':memory:');
    migrate(db, [
      { version: 1, up: 'CREATE TABLE a (x)' },
      { version: 2, up: 'CREATE TABLE b (y)' },
    ]);
    expect(() => {
      migrate(db, [{ version: 1, up: 'CREATE TABLE a (x)' }]);
    }).toThrow(SchemaTooNewError);
  });

  it('brings every workspace database up to date at startup, used lately or not', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-idle-'));
    fs.mkdirSync(path.join(dataDir, 'workspaces'));
    const file = path.join(dataDir, 'workspaces', '01JA0000000000000000000000.db');
    const db = new Database(file);
    migrate(db, workspaceMigrations.slice(0, 5));
    db.close();
    const storage = testStorage(dataDir);
    await storage.init();
    await storage.close();
    const after = new Database(file);
    expect(after.pragma('user_version', { simple: true })).toBe(workspaceMigrations.length);
    after.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('skips a corrupt workspace database at startup: it affects only its own workspace', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-corrupt-'));
    fs.mkdirSync(path.join(dataDir, 'workspaces'));
    fs.writeFileSync(
      path.join(dataDir, 'workspaces', '01JA0000000000000000000000.db'),
      'x'.repeat(8192),
    );
    const storage = testStorage(dataDir);
    await storage.init();
    await storage.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses to start on a workspace database from a newer Budd', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-newer-'));
    fs.mkdirSync(path.join(dataDir, 'workspaces'));
    const db = new Database(path.join(dataDir, 'workspaces', '01JA0000000000000000000000.db'));
    db.pragma('user_version = 99');
    expect(() => testStorage(dataDir).init()).toThrow(/schema 99, this version knows \d+/);
    // The refusal let go of the data directory, so the right version can start.
    db.pragma(`user_version = ${String(workspaceMigrations.length)}`);
    db.close();
    const storage = testStorage(dataDir);
    await storage.init();
    await storage.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects gaps in migration versions', () => {
    expect(() => {
      migrate(new Database(':memory:'), [{ version: 2, up: '' }]);
    }).toThrow(/expected 1/);
  });
});
