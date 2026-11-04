import { log } from '../log.js';
import type { AdminContext, WorkspaceGateway } from '../storage/gateway.js';
import type { Web } from './web.js';

export const ERASE_EXPIRED_REASON =
  'That confirmation is no longer valid: it expired, was already used, or came from another browser session.';
export const ERASE_EXPIRED = `${ERASE_EXPIRED_REASON} Nothing was deleted.`;

/** Erases a workspace the human has confirmed, and signs out every account erased with it. */
export async function eraseWorkspace(
  gateway: WorkspaceGateway,
  web: Web,
  ctx: AdminContext,
): Promise<void> {
  const accounts = await gateway.eraseWorkspace(ctx);
  web.sessions.endAccounts(accounts.map((a) => a.id));
  log.info('workspace erased', {
    workspace: ctx.workspace.slug,
    accounts_removed: accounts.length,
    via: 'ui',
  });
}
