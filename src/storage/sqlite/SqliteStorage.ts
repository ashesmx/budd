import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AuditEntry } from '../../domain/types.js';
import type {
  AuthStore,
  ConsoleStore,
  ControlStore,
  Storage,
  WorkspaceLimits,
  WorkspaceStore,
} from '../Storage.js';
import { controlMigrations } from './controlMigrations.js';
import { lockDataDir } from './dataDirLock.js';
import type { ErasedAccount } from '../../domain/auth.js';
import { eraseWorkspaceData, workspaceDbFile } from './erase.js';
import { ensurePrivateDir, migrateWorkspaces, openSqlite } from './open.js';
import { SqliteAuthStore } from './SqliteAuthStore.js';
import { SqliteConsoleStore } from './SqliteConsoleStore.js';
import { SqliteControlStore } from './SqliteControlStore.js';
import { SqliteWorkspaceStore } from './SqliteWorkspaceStore.js';
import { run } from './async.js';
import { workspaceMigrations } from './workspaceMigrations.js';

export class SqliteStorage implements Storage {
  private controlDb: Database.Database | undefined;
  private controlStore: SqliteControlStore | undefined;
  private authStore: SqliteAuthStore | undefined;
  private consoleStore: SqliteConsoleStore | undefined;
  private unlock: (() => void) | undefined;
  private readonly workspaces = new Map<string, { db: Database.Database; store: WorkspaceStore }>();
  private readonly auditListeners: ((workspaceId: string, entry: AuditEntry) => void)[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly limits: WorkspaceLimits,
    /** API keys made before keys expired get this long from the upgrade. */
    private readonly keyIdleExpiryMs: number,
  ) {}

  get control(): ControlStore {
    if (!this.controlStore) throw new Error('storage not initialised');
    return this.controlStore;
  }

  get auth(): AuthStore {
    if (!this.authStore) throw new Error('storage not initialised');
    return this.authStore;
  }

  get console(): ConsoleStore {
    if (!this.consoleStore) throw new Error('storage not initialised');
    return this.consoleStore;
  }

  workspaceDiskBytes(workspaceId: string): Promise<number> {
    return run(() => {
      const file = workspaceDbFile(this.dataDir, workspaceId);
      return [file, `${file}-wal`].reduce(
        (n, f) => n + (fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0),
        0,
      );
    });
  }

  init(): Promise<void> {
    ensurePrivateDir(this.dataDir);
    this.unlock = lockDataDir(this.dataDir);
    try {
      this.controlDb = openSqlite(path.join(this.dataDir, 'control.db'), controlMigrations);
      this.controlDb
        .prepare('UPDATE connection_keys SET expires_at = ? WHERE expires_at IS NULL')
        .run(Date.now() + this.keyIdleExpiryMs);
      migrateWorkspaces(this.dataDir);
    } catch (err) {
      this.controlDb?.close();
      this.controlDb = undefined;
      this.unlock();
      this.unlock = undefined;
      throw err;
    }
    this.controlStore = new SqliteControlStore(this.controlDb);
    this.authStore = new SqliteAuthStore(this.controlDb);
    this.consoleStore = new SqliteConsoleStore(this.controlDb);
    return Promise.resolve();
  }

  health(): Promise<{ ok: boolean }> {
    try {
      const row = this.controlDb?.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return Promise.resolve({ ok: row?.ok === 1 });
    } catch {
      return Promise.resolve({ ok: false });
    }
  }

  onAudit(listener: (workspaceId: string, entry: AuditEntry) => void): void {
    this.auditListeners.push(listener);
  }

  openWorkspace(workspaceId: string): Promise<WorkspaceStore> {
    let entry = this.workspaces.get(workspaceId);
    if (!entry) {
      // Opening creates the file, so an erased workspace must not be reopened.
      if (!this.controlStore?.hasWorkspace(workspaceId)) {
        return Promise.reject(new Error(`no workspace with id "${workspaceId}"`));
      }
      const db = openSqlite(workspaceDbFile(this.dataDir, workspaceId), workspaceMigrations);
      const notify = (e: AuditEntry) => {
        for (const listener of this.auditListeners) listener(workspaceId, e);
      };
      entry = { db, store: new SqliteWorkspaceStore(db, this.limits, notify) };
      this.workspaces.set(workspaceId, entry);
    }
    return Promise.resolve(entry.store);
  }

  eraseWorkspace(workspaceId: string): Promise<ErasedAccount[]> {
    return run(() => {
      if (!this.controlDb) throw new Error('storage not initialised');
      this.workspaces.get(workspaceId)?.db.close();
      this.workspaces.delete(workspaceId);
      return eraseWorkspaceData(this.controlDb, this.dataDir, workspaceId);
    });
  }

  close(): Promise<void> {
    for (const { db } of this.workspaces.values()) db.close();
    this.workspaces.clear();
    this.controlDb?.close();
    this.controlDb = undefined;
    this.controlStore = undefined;
    this.authStore = undefined;
    this.consoleStore = undefined;
    this.unlock?.();
    this.unlock = undefined;
    return Promise.resolve();
  }
}
