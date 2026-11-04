import fs from 'node:fs';
import type { Connection, Handle } from '../../domain/types.js';
import { SYSTEM_CONNECTION_SLUG } from '../../domain/slug.js';
import { workspaceDbFile } from './erase.js';
import { openControlOffline, openWorkspaceOffline } from './open.js';
import { SqliteAuthStore } from './SqliteAuthStore.js';
import { SqliteWorkspaceStore } from './SqliteWorkspaceStore.js';
import { revokeBlocked } from '../../admin/revokeBlocked.js';
import type { WorkspaceLimits } from '../Storage.js';

/**
 * The CLI only lists and blocks: it adds no connections, and a human's audit
 * entries are always written, so the caps never apply.
 */
const OFFLINE_LIMITS: WorkspaceLimits = {
  maxConnections: Infinity,
  maxWorkspaceBytes: Infinity,
  maxAuditBytes: Infinity,
  rotateAudit: false,
};

/**
 * `budd connections` and `budd block`: a way to see and stop a misbehaving
 * connection without the UI, e.g. when it keeps the human out of it. They
 * work while Budd is running, through the same stores as the server.
 */
async function withWorkspace<T>(
  dataDir: string,
  slug: string,
  fn: (store: SqliteWorkspaceStore, auth: SqliteAuthStore, workspaceId: string) => Promise<T>,
): Promise<T | 'unknown_workspace'> {
  const control = openControlOffline(dataDir);
  try {
    const workspace = control.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug) as
      { id: string } | undefined;
    const file = workspace && workspaceDbFile(dataDir, workspace.id);
    if (!workspace || !file || !fs.existsSync(file)) return 'unknown_workspace';
    const db = openWorkspaceOffline(file);
    try {
      const store = new SqliteWorkspaceStore(db, OFFLINE_LIMITS);
      return await fn(store, new SqliteAuthStore(control), workspace.id);
    } finally {
      db.close();
    }
  } finally {
    control.close();
  }
}

export interface ConnectionSummary extends Connection {
  handles: string[];
}

export function listConnectionsOffline(
  dataDir: string,
  workspace: string,
): Promise<ConnectionSummary[] | 'unknown_workspace'> {
  return withWorkspace(dataDir, workspace, async (store) => {
    const handles: Handle[] = await store.listHandles();
    return (await store.listConnections())
      .filter((c) => c.slug !== SYSTEM_CONNECTION_SLUG)
      .map((c) => ({
        ...c,
        handles: handles.filter((h) => h.connectionId === c.id).map((h) => h.name),
      }));
  });
}

/** Blocks a connection and, as the UI does, revokes its tokens and API key. */
export function blockConnectionOffline(
  dataDir: string,
  workspace: string,
  connection: string,
  now: number = Date.now(),
): Promise<'blocked' | 'already_blocked' | 'unknown_connection' | 'unknown_workspace'> {
  return withWorkspace(dataDir, workspace, async (store, auth, workspaceId) => {
    const c = await store.getConnectionBySlug(connection);
    if (!c || c.slug === SYSTEM_CONNECTION_SLUG) return 'unknown_connection' as const;
    const changed = await store.setConnectionStatus({
      connectionId: c.id,
      status: 'blocked',
      now,
    });
    await revokeBlocked(auth, (entry) => store.appendAudit(entry), {
      workspaceId,
      connectionId: c.id,
      reason: 'connection_blocked',
      now,
      via: 'cli',
    });
    return changed ? ('blocked' as const) : ('already_blocked' as const);
  });
}
