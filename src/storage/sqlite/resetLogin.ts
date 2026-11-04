import fs from 'node:fs';
import path from 'node:path';
import { lockDataDir } from './dataDirLock.js';
import { openControlOffline } from './open.js';

/**
 * Local mode: forgets the UI login, so the next start prints a new setup link.
 * Used by `budd reset-login`. Returns whether a login existed. Throws
 * DataDirInUseError while Budd is running: it would keep its setup state.
 */
export function resetLocalLogin(dataDir: string): boolean {
  if (!fs.existsSync(path.join(dataDir, 'control.db'))) return false;
  const db = openControlOffline(dataDir);
  let unlock: (() => void) | undefined;
  try {
    unlock = lockDataDir(dataDir);
    return db.prepare('DELETE FROM local_logins').run().changes > 0;
  } finally {
    unlock?.();
    db.close();
  }
}
