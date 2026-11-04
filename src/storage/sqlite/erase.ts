import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ErasedAccount } from '../../domain/auth.js';
import { lockDataDir } from './dataDirLock.js';
import { openControlOffline } from './open.js';

/** A ULID, so it is always a safe file name. */
const WORKSPACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function workspaceDbFile(dataDir: string, workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`invalid workspace id "${workspaceId}"`);
  return path.join(dataDir, 'workspaces', `${workspaceId}.db`);
}

/**
 * Erases a workspace: its database file, its row in the control DB
 * (memberships, OAuth grants, codes and tokens go with it), and every account
 * left without a workspace. The workspace DB must not be open. The file goes
 * first: if deleting it fails, the workspace is still listed and can be erased
 * again, rather than its messages being left behind unlisted. Returns the accounts
 * removed. The UI (through SqliteStorage) and `budd erase-workspace` both
 * erase through here.
 */
export function eraseWorkspaceData(
  control: Database.Database,
  dataDir: string,
  workspaceId: string,
): ErasedAccount[] {
  const file = workspaceDbFile(dataDir, workspaceId);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  control.pragma('secure_delete = ON');
  const removed = control.transaction(() => {
    const orphaned = control
      .prepare(
        `DELETE FROM accounts
         WHERE id IN (SELECT account_id FROM memberships WHERE workspace_id = @id)
           AND NOT EXISTS (SELECT 1 FROM memberships m
                           WHERE m.account_id = accounts.id AND m.workspace_id <> @id)
         RETURNING id, email`,
      )
      .all({ id: workspaceId }) as ErasedAccount[];
    control.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    return orphaned;
  })();
  // Copy the zeroed pages into control.db and empty the WAL, which still holds the old rows.
  control.pragma('wal_checkpoint(TRUNCATE)');
  return removed;
}

/**
 * `budd erase-workspace`: erases the workspace named `slug` while Budd is
 * stopped. Throws DataDirInUseError while Budd is running, because the server
 * keeps each workspace's database open.
 */
export function eraseWorkspaceOffline(
  dataDir: string,
  slug: string,
): { id: string; accounts: ErasedAccount[] } | undefined {
  const db = openControlOffline(dataDir);
  let unlock: (() => void) | undefined;
  try {
    unlock = lockDataDir(dataDir);
    const workspace = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug) as
      { id: string } | undefined;
    if (!workspace) return undefined;
    return { id: workspace.id, accounts: eraseWorkspaceData(db, dataDir, workspace.id) };
  } finally {
    unlock?.();
    db.close();
  }
}
