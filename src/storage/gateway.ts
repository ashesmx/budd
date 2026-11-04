import { isValidSlug, RESERVED_CONNECTION_SLUGS, SLUG_RULES } from '../domain/slug.js';
import type { ConnectionKey, ErasedAccount, OAuthGrant } from '../domain/auth.js';
import type { AuditEntry, Connection, Workspace } from '../domain/types.js';
import type { Storage, WorkspaceStore } from './Storage.js';

/**
 * The authenticated identity behind a tool call: a verified connection in one
 * workspace. Only the gateway creates these; it refuses any it did not issue.
 */
export interface ConnectionContext {
  readonly workspace: Workspace;
  readonly connection: Connection;
}

/**
 * A human administering one workspace (the UI). In local mode that is whoever
 * can reach the loopback UI; in hosted mode, a signed-in member.
 */
export interface AdminContext {
  readonly workspace: Workspace;
}

/** Why a connection can't be used, and what a human can do about it. */
function blockedMessage(connection: Connection): string {
  return connection.archivedAt === null
    ? `Connection "${connection.slug}" has been blocked in this workspace. A human can unblock it in the Budd UI.`
    : `Connection "${connection.slug}" has been archived in this workspace. A human can restore and unblock it in the Budd UI.`;
}

/** A failure the caller should see verbatim (it says what to do next). */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    readonly code:
      | 'invalid_connection'
      | 'reserved_connection'
      | 'blocked'
      | 'connection_limit'
      | 'unknown_workspace'
      | 'not_a_member',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The only path to a workspace database. It resolves the database from an
 * authenticated context, so a caller can only ever reach its own workspace.
 */
export class WorkspaceGateway {
  private readonly issued = new WeakSet<ConnectionContext>();
  private readonly issuedAdmin = new WeakSet<AdminContext>();

  constructor(private readonly storage: Storage) {}

  /**
   * Local mode: the connection is named by the URL path. Registers it in the
   * local workspace on first contact.
   */
  async connectLocal(slug: string, now: number): Promise<ConnectionContext> {
    if (!isValidSlug(slug)) {
      throw new GatewayError(
        'invalid_connection',
        `"${slug}" is not a valid connection name. Use ${SLUG_RULES}, e.g. /mcp/claude-desktop.`,
      );
    }
    const workspace = await this.storage.control.ensureLocalWorkspace(now);
    if (RESERVED_CONNECTION_SLUGS.has(slug) || slug === workspace.slug) {
      throw new GatewayError(
        'reserved_connection',
        `"${slug}" is reserved and can't be used as a connection name. Pick another, e.g. /mcp/claude-desktop.`,
      );
    }
    const store = await this.storage.openWorkspace(workspace.id);
    const existing = await store.getConnectionBySlug(slug);
    if (existing?.status === 'blocked') throw new GatewayError('blocked', blockedMessage(existing));
    const connection = await store.touchConnection(slug, now);
    if (connection === 'limit') {
      throw new GatewayError(
        'connection_limit',
        `"${slug}" is a new connection, and this workspace already has the most it may have (MAX_CONNECTIONS_PER_WORKSPACE). Ask your human to archive one they no longer use in the Budd UI.`,
      );
    }
    return this.issue({ workspace, connection });
  }

  /**
   * Hosted mode: the connection behind a verified access token's grant. The
   * hierarchy is account > workspace > connection: a connection works only
   * while the account that approved it (or created its key) is still a member
   * of its workspace.
   */
  async connectGrant(grant: OAuthGrant, now: number): Promise<ConnectionContext> {
    return this.connectApproved(
      grant,
      now,
      'The account that approved this connection no longer has access to its workspace. Connect again.',
    );
  }

  /** Hosted mode: the connection behind a verified API key (ADR 0016), on the same terms. */
  async connectKey(key: ConnectionKey, now: number): Promise<ConnectionContext> {
    const ctx = await this.connectApproved(
      key,
      now,
      'Whoever made this API key no longer has access to its workspace, so it no longer works. A member of the workspace can give the connection a new key in the Budd UI.',
    );
    // Only a connection a human made for a key may be reached with one, never an app's.
    if (ctx.connection.kind !== 'key') {
      throw new GatewayError('invalid_connection', 'This API key belongs to no key connection.');
    }
    return ctx;
  }

  private async connectApproved(
    approval: { accountId: string; workspaceId: string; connectionId: string },
    now: number,
    notMember: string,
  ): Promise<ConnectionContext> {
    const workspaces = await this.storage.auth.listWorkspacesForAccount(approval.accountId);
    const workspace = workspaces.find((w) => w.id === approval.workspaceId);
    if (!workspace) {
      throw new GatewayError('not_a_member', notMember);
    }
    const store = await this.storage.openWorkspace(workspace.id);
    const connection = await store.getConnectionById(approval.connectionId);
    if (!connection) {
      throw new GatewayError('invalid_connection', 'This connection no longer exists.');
    }
    if (connection.status === 'blocked') {
      throw new GatewayError('blocked', blockedMessage(connection));
    }
    await store.touchConnectionById(connection.id, now);
    return this.issue({ workspace, connection: { ...connection, lastSeenAt: now } });
  }

  /** Hosted mode: a signed-in account administering one of its own workspaces. */
  async adminForAccount(accountId: string, workspaceId: string): Promise<AdminContext> {
    const workspaces = await this.storage.auth.listWorkspacesForAccount(accountId);
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      throw new GatewayError('not_a_member', 'You are not a member of that workspace.');
    }
    const ctx = Object.freeze({ workspace });
    this.issuedAdmin.add(ctx);
    return ctx;
  }

  /** Writes an audit row for Budd itself (sign-ins, token events). Never reachable from MCP. */
  async appendSystemAudit(workspaceId: string, entry: AuditEntry): Promise<void> {
    const store = await this.storage.openWorkspace(workspaceId);
    await store.appendAudit(entry);
  }

  /** The workspace store for an authenticated context. Re-checks the connection is still active. */
  async forConnection(ctx: ConnectionContext): Promise<WorkspaceStore> {
    if (!this.issued.has(ctx)) throw new Error('connection context was not issued by the gateway');
    const store = await this.storage.openWorkspace(ctx.workspace.id);
    const current = await store.getConnectionById(ctx.connection.id);
    if (current?.status !== 'active') {
      throw new GatewayError('blocked', blockedMessage(current ?? ctx.connection));
    }
    return store;
  }

  /** Local mode: the human at the loopback UI administers the `local` workspace. */
  async adminLocal(now: number): Promise<AdminContext> {
    const workspace = await this.storage.control.ensureLocalWorkspace(now);
    const ctx = Object.freeze({ workspace });
    this.issuedAdmin.add(ctx);
    return ctx;
  }

  /** The workspace store for an admin context. */
  async forAdmin(ctx: AdminContext): Promise<WorkspaceStore> {
    if (!this.issuedAdmin.has(ctx)) throw new Error('admin context was not issued by the gateway');
    return this.storage.openWorkspace(ctx.workspace.id);
  }

  /** See `Storage.eraseWorkspace`. Callers must have confirmed it with the human. */
  async eraseWorkspace(ctx: AdminContext): Promise<ErasedAccount[]> {
    if (!this.issuedAdmin.has(ctx)) throw new Error('admin context was not issued by the gateway');
    return this.storage.eraseWorkspace(ctx.workspace.id);
  }

  /**
   * Runs `fn` against one workspace, skipping it if it's gone. For Budd's own
   * jobs: wake-ups use it when mail arrives, never with a workspace a request named.
   */
  async forWorkspace(
    workspaceId: string,
    fn: (workspace: Workspace, store: WorkspaceStore) => Promise<void>,
  ): Promise<void> {
    const workspace = await this.storage.control.getWorkspaceById(workspaceId);
    if (!workspace) return;
    try {
      await fn(workspace, await this.storage.openWorkspace(workspace.id));
    } catch (err) {
      if (await this.storage.control.getWorkspaceById(workspace.id)) throw err;
    }
  }

  /**
   * Runs `fn` against every workspace in turn. For Budd's own maintenance jobs
   * (the sweeper) only; never reachable from a request.
   */
  async forEachWorkspace(
    fn: (workspace: Workspace, store: WorkspaceStore) => Promise<void>,
  ): Promise<void> {
    for (const workspace of await this.storage.control.listWorkspaces()) {
      try {
        await fn(workspace, await this.storage.openWorkspace(workspace.id));
      } catch (err) {
        // Erased while this ran: skip it and carry on with the rest.
        if (await this.storage.control.getWorkspaceById(workspace.id)) throw err;
      }
    }
  }

  private issue(ctx: ConnectionContext): ConnectionContext {
    const frozen = Object.freeze(ctx);
    this.issued.add(frozen);
    return frozen;
  }
}
