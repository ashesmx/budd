import type { Policy, PolicyMode } from '../domain/types.js';

/** Whether `policy`'s connection accepts messages from `fromConnectionId` (§9). */
export function accepts(policy: Policy, fromConnectionId: string): boolean {
  if (policy.connectionId === fromConnectionId) return true; // a connection's own handles
  return policy.mode === 'all' || policy.allowedConnectionIds.includes(fromConnectionId);
}

/**
 * True if going from `before` to `after` lets in anyone who was kept out:
 * switching to `all`, or adding a connection to an allowlist.
 */
export function isWidening(
  before: { mode: PolicyMode; allowedConnectionIds: string[] },
  after: { mode: PolicyMode; allowedConnectionIds: string[] },
): boolean {
  if (before.mode === 'all') return false;
  if (after.mode === 'all') return true;
  return after.allowedConnectionIds.some((id) => !before.allowedConnectionIds.includes(id));
}

export const POLICY_HUMAN_ONLY =
  'Only a human can widen a contact policy, in the Budd UI; agents can’t, and there is no way to request it through Budd.';
