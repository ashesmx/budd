import { openControlOffline } from './open.js';

export interface AccountSummary {
  email: string | null;
  workspace: string;
  createdAt: number;
  /** Apps the person has approved, and how many hold a live (unexpired, unrevoked) token. */
  apps: number;
  liveApps: number;
  /** API keys the person made that still work (ADR 0016): not revoked, and not expired. */
  keys: number;
}

/**
 * Who has an account, and which workspace is theirs. Used by `budd accounts`,
 * so an operator can find the workspace to erase when someone leaves.
 */
export function listAccounts(dataDir: string, now: number = Date.now()): AccountSummary[] {
  const db = openControlOffline(dataDir, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT a.email, w.slug, a.created_at,
           (SELECT COUNT(*) FROM oauth_grants g
             WHERE g.account_id = a.id AND g.workspace_id = w.id) AS apps,
           (SELECT COUNT(DISTINCT g.id) FROM oauth_grants g
             JOIN oauth_tokens t ON t.grant_id = g.id
             WHERE g.account_id = a.id AND g.workspace_id = w.id
               AND t.kind = 'refresh' AND t.revoked_at IS NULL
               AND t.rotated_at IS NULL AND t.expires_at > ?) AS live_apps,
           (SELECT COUNT(*) FROM connection_keys k
             WHERE k.account_id = a.id AND k.workspace_id = w.id
               AND k.revoked_at IS NULL AND k.expires_at > ?) AS keys
         FROM accounts a
         JOIN memberships m ON m.account_id = a.id
         JOIN workspaces w ON w.id = m.workspace_id
         ORDER BY a.email, w.slug`,
      )
      .all(now, now) as {
      email: string | null;
      slug: string;
      created_at: number;
      apps: number;
      live_apps: number;
      keys: number;
    }[];
    return rows.map((r) => ({
      email: r.email,
      workspace: r.slug,
      createdAt: r.created_at,
      apps: r.apps,
      liveApps: r.live_apps,
      keys: r.keys,
    }));
  } finally {
    db.close();
  }
}
