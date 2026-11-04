import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../../log.js';
import { controlMigrations } from './controlMigrations.js';
import { migrate, type Migration } from './migrate.js';
import { workspaceMigrations } from './workspaceMigrations.js';

/**
 * Creates `dir` if needed and makes it private to Budd's OS user (0700), so
 * other users on the machine can't read messages, hashes or tokens. Existing
 * installs are tightened too. A directory Budd doesn't own (e.g. a volume
 * mounted by root) is left as it is, with a warning.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((fs.statSync(dir).mode & 0o077) === 0) return;
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    log.warn('could not make directory private', { dir, error: String(err) });
  }
}

/**
 * For CLI commands: opens `control.db` as it is, without migrating. Refuses
 * if it's missing, or if its schema isn't exactly the one this version knows.
 */
export function openControlOffline(
  dataDir: string,
  options: { readonly?: boolean } = {},
): Database.Database {
  const file = path.join(dataDir, 'control.db');
  if (!fs.existsSync(file)) {
    throw new Error(`No Budd data found: ${file} does not exist. Is DATA_DIR right?`);
  }
  const db = new Database(file, { fileMustExist: true, readonly: options.readonly ?? false });
  checkSchema(db, controlMigrations.length);
  return db;
}

function checkSchema(db: Database.Database, known: number): void {
  const schema = db.pragma('user_version', { simple: true }) as number;
  if (schema !== known) {
    db.close();
    throw new Error(
      schema < known
        ? 'the data predates this version of Budd. Start (or restart) this version of Budd once to update it, then run this again.'
        : 'the data was last used by a newer version of Budd. Run this command from that version.',
    );
  }
  db.pragma('foreign_keys = ON');
}

/** Opens a SQLite file in WAL mode with sane defaults and runs its migrations. */
export function openSqlite(file: string, migrations: readonly Migration[]): Database.Database {
  ensurePrivateDir(path.dirname(file));
  const db = new Database(file);
  // Files from installs before Budd set its umask may still be 0644.
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if ((fs.statSync(f).mode & 0o077) !== 0) fs.chmodSync(f, 0o600);
    } catch {
      // missing (no WAL yet) or not ours: the 0700 directory still protects it
    }
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Deleted rows are zeroed, so erased or expired data doesn't linger in free
  // pages (or in backups taken later).
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  // Table statistics, so queries over a window of messages use the index on
  // time; sampled, so even the first open of a big workspace stays quick.
  db.pragma('analysis_limit = 400');
  db.pragma('optimize = 0x10002');
  return db;
}

/**
 * Brings every workspace database up to date at startup. A failed migration
 * then stops Budd straight away, not when that workspace's user next comes
 * back; an older Budd refuses a newer one's data instead of starting on it;
 * and the CLI, which never migrates, finds every workspace at this version.
 */
export function migrateWorkspaces(dataDir: string): void {
  const dir = path.join(dataDir, 'workspaces');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.db'))) {
    const file = path.join(dir, name);
    let schema: number;
    try {
      // SQLite reads nothing until asked, so only a query finds a corrupt file.
      const probe = new Database(file, { readonly: true, fileMustExist: true });
      try {
        schema = probe.pragma('user_version', { simple: true }) as number;
      } finally {
        probe.close();
      }
    } catch (err) {
      // An unreadable file affects only its own workspace, as it always has.
      log.warn('could not read a workspace database', { file, error: String(err) });
      continue;
    }
    if (schema !== workspaceMigrations.length) openSqlite(file, workspaceMigrations).close();
  }
}

/** For CLI commands: opens a workspace database, refusing it unless it's at this version. */
export function openWorkspaceOffline(file: string): Database.Database {
  const db = new Database(file, { fileMustExist: true });
  checkSchema(db, workspaceMigrations.length);
  return db;
}
