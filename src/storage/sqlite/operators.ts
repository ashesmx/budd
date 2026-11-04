import { hashToken, randomToken } from '../../auth/tokens.js';
import { OPERATOR_LINK_TTL_MS } from '../../domain/auth.js';
import { openControlOffline } from './open.js';
import { SqliteConsoleStore } from './SqliteConsoleStore.js';

/**
 * A one-time code for `budd operator`'s link (ADR 0022), for the account
 * signed in with `email` only. Works while Budd is running.
 */
export async function createOperatorLink(
  dataDir: string,
  email: string,
  now: number = Date.now(),
): Promise<string> {
  const db = openControlOffline(dataDir);
  try {
    const code = randomToken();
    await new SqliteConsoleStore(db).createOperatorLink(
      hashToken(code),
      email,
      now + OPERATOR_LINK_TTL_MS,
      now,
    );
    return code;
  } finally {
    db.close();
  }
}

export interface OperatorSummary {
  accountId: string;
  email: string | null;
  addedAt: number;
}

/** Who can open the console, with their email: the server's own view (`budd operators`). */
export function listOperatorsOffline(dataDir: string): OperatorSummary[] {
  const db = openControlOffline(dataDir, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT o.account_id, a.email, o.added_at FROM operators o
           JOIN accounts a ON a.id = o.account_id ORDER BY o.added_at`,
        )
        .all() as { account_id: string; email: string | null; added_at: number }[]
    ).map((r) => ({ accountId: r.account_id, email: r.email, addedAt: r.added_at }));
  } finally {
    db.close();
  }
}

/** Takes the console away from an account at once. False if it wasn't an operator. */
export async function removeOperatorOffline(dataDir: string, accountId: string): Promise<boolean> {
  const db = openControlOffline(dataDir);
  try {
    return await new SqliteConsoleStore(db).removeOperator(accountId);
  } finally {
    db.close();
  }
}
