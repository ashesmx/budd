import { hashToken, randomToken } from '../../auth/tokens.js';
import { openControlOffline } from './open.js';
import { LOGIN_LINK_TTL_MS } from '../../domain/auth.js';
import { SqliteAuthStore } from './SqliteAuthStore.js';

/**
 * Local mode: a one-time sign-in code for `budd login`, so a human kept out
 * by failed password attempts (any local process can make them) can still
 * get in. Works while Budd is running. Returns undefined if no UI login has
 * been set up yet.
 */
export async function createLoginLink(
  dataDir: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  const db = openControlOffline(dataDir);
  try {
    const auth = new SqliteAuthStore(db);
    if (!(await auth.getLocalLogin())) return undefined;
    const code = randomToken();
    await auth.createLoginLink(hashToken(code), now + LOGIN_LINK_TTL_MS, now);
    return code;
  } finally {
    db.close();
  }
}
