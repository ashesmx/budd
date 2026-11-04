import type { AuditEntry } from '../domain/types.js';
import type { AuthStore } from '../storage/Storage.js';

/**
 * A blocked or archived connection loses its tokens and API key (§11), and the
 * audit log says so. Shared by the server and `budd block`, so both leave the
 * same record.
 */
export async function revokeBlocked(
  auth: AuthStore,
  appendAudit: (entry: AuditEntry) => Promise<void>,
  blocked: {
    workspaceId: string;
    connectionId: string;
    reason: 'connection_blocked' | 'connection_archived';
    now: number;
    via?: 'cli';
  },
): Promise<{ tokens: number; keys: number }> {
  const { workspaceId, connectionId, reason, now, via } = blocked;
  const revoked = await auth.revokeConnection(workspaceId, connectionId, now);
  const entry = { at: now, actor: 'human', connectionId } as const;
  if (revoked.tokens > 0) {
    await appendAudit({
      ...entry,
      event: 'token_revoked',
      detail: { reason, tokens: revoked.tokens, ...(via && { via }) },
    });
  }
  if (revoked.keys > 0) {
    await appendAudit({ ...entry, event: 'key_revoked', detail: { reason, ...(via && { via }) } });
  }
  return revoked;
}
