import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { slugify, withSuffix } from '../../domain/slug.js';
import type { Workspace } from '../../domain/types.js';
import type { ControlStore } from '../Storage.js';
import { run } from './async.js';

interface WorkspaceRow {
  id: string;
  slug: string;
  created_at: number;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  slug: row.slug,
  createdAt: row.created_at,
});

export const LOCAL_WORKSPACE_SLUG = 'local';

export class SqliteControlStore implements ControlStore {
  constructor(private readonly db: Database.Database) {}

  getWorkspaceById(id: string): Promise<Workspace | undefined> {
    return run(() => this.workspaceWhere('id', id));
  }

  getWorkspaceBySlug(slug: string): Promise<Workspace | undefined> {
    return run(() => this.workspaceWhere('slug', slug));
  }

  workspaceSecretKey(workspaceId: string): Promise<Buffer | undefined> {
    return run(() => {
      const row = this.db
        .prepare('SELECT secret_key FROM workspaces WHERE id = ?')
        .get(workspaceId) as { secret_key: Buffer | null } | undefined;
      return row?.secret_key ?? undefined;
    });
  }

  setWorkspaceSecretKey(
    workspaceId: string,
    stored: Buffer | null,
    expected: Buffer | null,
  ): Promise<boolean> {
    return run(
      () =>
        this.db
          .prepare('UPDATE workspaces SET secret_key = ? WHERE id = ? AND secret_key IS ?')
          .run(stored, workspaceId, expected).changes === 1,
    );
  }

  listWorkspaces(): Promise<Workspace[]> {
    return run(() =>
      (
        this.db
          .prepare('SELECT id, slug, created_at FROM workspaces ORDER BY slug')
          .all() as WorkspaceRow[]
      ).map(toWorkspace),
    );
  }

  createWorkspaceForAccount(input: {
    email: string | null;
    slugBase: string;
    now: number;
  }): Promise<Workspace> {
    return run(() =>
      this.db.transaction(() => {
        const accountId = this.ensureAccount(input.email, input.now);
        const base = slugify(input.slugBase);
        let slug = base;
        for (let n = 2; this.workspaceWhere('slug', slug); n++) slug = withSuffix(base, n);
        return this.insertWorkspace(accountId, slug, input.now);
      })(),
    );
  }

  ensureLocalWorkspace(now: number): Promise<Workspace> {
    return run(() =>
      this.db.transaction(() => {
        const existing = this.workspaceWhere('slug', LOCAL_WORKSPACE_SLUG);
        if (existing) return existing;
        const accountId = this.ensureAccount(null, now);
        return this.insertWorkspace(accountId, LOCAL_WORKSPACE_SLUG, now);
      })(),
    );
  }

  /** Synchronous, for SqliteStorage: whether the workspace is still registered. */
  hasWorkspace(id: string): boolean {
    return this.workspaceWhere('id', id) !== undefined;
  }

  private workspaceWhere(column: 'id' | 'slug', value: string): Workspace | undefined {
    const row = this.db
      .prepare(`SELECT id, slug, created_at FROM workspaces WHERE ${column} = ?`)
      .get(value) as WorkspaceRow | undefined;
    return row && toWorkspace(row);
  }

  /**
   * Test and local-mode helper. Never use it for sign-in: matching accounts by
   * email would let whoever later holds an address take over the account.
   * Sign-in matches on (issuer, subject) in SqliteAuthStore.signIn.
   */
  private ensureAccount(email: string | null, now: number): string {
    if (email !== null) {
      const row = this.db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as
        { id: string } | undefined;
      if (row) return row.id;
    }
    const id = ulid(now);
    this.db
      .prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)')
      .run(id, email, now);
    return id;
  }

  private insertWorkspace(accountId: string, slug: string, now: number): Workspace {
    const id = ulid(now);
    this.db
      .prepare(
        // Its key is made when it first needs one (WorkspaceKeys), never stored unlocked.
        'INSERT INTO workspaces (id, slug, created_at) VALUES (?, ?, ?)',
      )
      .run(id, slug, now);
    this.db
      .prepare('INSERT INTO memberships (account_id, workspace_id, created_at) VALUES (?, ?, ?)')
      .run(accountId, id, now);
    return { id, slug, createdAt: now };
  }
}
