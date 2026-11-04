import { openControlOffline } from './open.js';

/**
 * For a lost BUDD_SECRET_KEY: forgets every workspace's wake-up key, so the
 * next wake-up a person enters makes a new one. What the old keys sealed stays
 * unreadable; messages are untouched. Safe while Budd runs: it reads keys as
 * it needs them. Returns how many workspaces had one.
 */
export function forgetWakeUpKeys(dataDir: string): number {
  const db = openControlOffline(dataDir);
  try {
    db.pragma('busy_timeout = 5000'); // Budd may be writing
    return db.prepare('UPDATE workspaces SET secret_key = NULL WHERE secret_key IS NOT NULL').run()
      .changes;
  } finally {
    db.close();
  }
}
