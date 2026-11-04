import type { Context } from 'hono';
import type { Account } from '../domain/auth.js';
import type { AuthStore, ConsoleStore } from '../storage/Storage.js';
import type { Profile } from './layout.js';
import type { Session } from './sessions.js';
import { csp, type Web } from './web.js';

export interface AccountMenuDeps {
  web: Web;
  auth: AuthStore;
  operators: ConsoleStore;
}

/** Whether an account may open the console: an operator, or local mode's one login. */
const isOperator = ({ web, operators }: AccountMenuDeps, accountId: string) =>
  web.hosted ? operators.isOperator(accountId) : Promise.resolve(true);

/** Who the account menu shows, in the UI and the console, and whether it offers Console. */
export async function accountMenu(
  c: Context,
  deps: AccountMenuDeps,
  session: Session,
  account: Account | undefined,
): Promise<{ profile: Profile | undefined; operator: boolean }> {
  const { web, auth } = deps;
  const name = web.hosted
    ? (account?.name ?? account?.email)
    : (await auth.getLocalLogin())?.username;
  const picture = web.hosted ? (account?.picture ?? null) : null;
  // The picture comes from the sign-in provider: let only its origin through, on this page.
  if (picture) c.header('Content-Security-Policy', csp(new URL(picture).origin));
  return {
    profile: name
      ? { name, picture, theme: account?.theme ?? 'system', csrf: session.csrf }
      : undefined,
    operator: account !== undefined && (await isOperator(deps, account.id)),
  };
}
