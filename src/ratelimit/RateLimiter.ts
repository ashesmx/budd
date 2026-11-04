/**
 * Decides whether a keyed action may proceed. v1 is in-memory per process,
 * so limits are per instance (another reason Budd is single-instance only).
 */
export interface RateLimiter {
  /** Consume one token for `key`; false if the caller is over the limit. */
  tryConsume(key: string, nowMs?: number): boolean;
}
