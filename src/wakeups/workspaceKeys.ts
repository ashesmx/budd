import { randomBytes } from 'node:crypto';
import { AdminError } from '../admin/Admin.js';
import { log } from '../log.js';
import type { WorkspaceGateway } from '../storage/gateway.js';
import type { ControlStore, WorkspaceStore } from '../storage/Storage.js';
import { open, seal } from './secrets.js';

/** As stored, a workspace key is these 32 bytes, or longer once locked with BUDD_SECRET_KEY. */
const RAW_KEY_LENGTH = 32;
const lockContext = (workspaceId: string) => `budd workspace key ${workspaceId}`;

/**
 * Each workspace's key for its wake-up secrets, in control.db. With
 * BUDD_SECRET_KEY set it's stored locked with it, so the data directory or a
 * backup alone opens nothing. A key Budd can't unlock is never replaced
 * automatically: a missing or mistyped BUDD_SECRET_KEY must not cost every
 * wake-up the moment a person saves one.
 */
export class WorkspaceKeys {
  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly control: ControlStore,
    private readonly secret: {
      /** BUDD_SECRET_KEY. */
      current?: Buffer | undefined;
      /** BUDD_SECRET_KEY_PREVIOUS: opens keys locked before a rotation. */
      previous?: Buffer | undefined;
    },
  ) {}

  /**
   * At startup: drops unused keys stored as they are (older Budds made one for
   * every workspace), locks the rest, moves keys locked with the previous
   * secret onto the current one, and says loudly if any won't open.
   */
  async init(): Promise<void> {
    let relocked = 0;
    let unopenable = 0;
    const tidy = async (id: string, store: WorkspaceStore) => {
      const stored = await this.control.workspaceSecretKey(id);
      if (!stored) return;
      if (stored.length === RAW_KEY_LENGTH && (await store.listWakeUps()).length === 0) {
        await this.control.setWorkspaceSecretKey(id, null, stored);
        return;
      }
      const { key, moved } = await this.unlock(id, stored);
      if (!key) unopenable++;
      if (moved) relocked++;
    };
    await this.gateway.forEachWorkspace(async ({ id, slug }, store) => {
      // A workspace that can't be read is left for later, not a reason not to start.
      try {
        await tidy(id, store);
      } catch (err) {
        log.error('workspace key not checked', { workspace: slug, error: String(err) });
      }
    });
    if (relocked > 0)
      log.info('workspace keys locked with BUDD_SECRET_KEY', { workspaces: relocked });
    if (unopenable > 0) {
      log.error(
        this.secret.current
          ? "BUDD_SECRET_KEY doesn't open these workspace keys: is it the one they were locked with? Their wake-ups aren't sent"
          : 'workspace keys are locked but BUDD_SECRET_KEY is missing: their wake-ups aren’t sent',
        { workspaces: unopenable },
      );
    }
  }

  /** The workspace's key; undefined if it has none or Budd can't unlock it. */
  async get(workspaceId: string): Promise<Buffer | undefined> {
    const stored = await this.control.workspaceSecretKey(workspaceId);
    return stored ? (await this.unlock(workspaceId, stored)).key : undefined;
  }

  /** For saving a wake-up: the key, created if the workspace has none yet. */
  async forSaving(workspaceId: string): Promise<Buffer> {
    const stored = await this.control.workspaceSecretKey(workspaceId);
    if (!stored) {
      const key = randomBytes(RAW_KEY_LENGTH);
      // Two first saves at once: one key wins, and both use it.
      if (
        await this.control.setWorkspaceSecretKey(workspaceId, this.stored(workspaceId, key), null)
      ) {
        return key;
      }
      return this.forSaving(workspaceId);
    }
    const { key } = await this.unlock(workspaceId, stored);
    if (key) return key;
    throw new AdminError(
      'invalid_input',
      "Budd can't open this workspace's wake-ups: BUDD_SECRET_KEY is missing, or isn't the one they were locked with. Nothing was saved. Ask whoever runs Budd.",
    );
  }

  /** How a key is stored: locked when there's a BUDD_SECRET_KEY. */
  private stored(workspaceId: string, key: Buffer): Buffer {
    return this.secret.current
      ? seal(this.secret.current, key.toString('base64'), lockContext(workspaceId))
      : key;
  }

  /**
   * Unlocks a stored key. One stored as it is, or locked with the previous
   * secret, is stored again locked with the current one (`moved`).
   */
  private async unlock(
    workspaceId: string,
    stored: Buffer,
  ): Promise<{ key: Buffer | undefined; moved: boolean }> {
    const openWith = (secret: Buffer | undefined) => {
      const text = secret && open(secret, stored, lockContext(workspaceId));
      return text === undefined ? undefined : Buffer.from(text, 'base64');
    };
    if (stored.length !== RAW_KEY_LENGTH) {
      const key = openWith(this.secret.current);
      if (key) return { key, moved: false };
    }
    const key = stored.length === RAW_KEY_LENGTH ? stored : openWith(this.secret.previous);
    const moved =
      key !== undefined &&
      this.secret.current !== undefined &&
      (await this.control.setWorkspaceSecretKey(
        workspaceId,
        this.stored(workspaceId, key),
        stored,
      ));
    return { key, moved };
  }
}
