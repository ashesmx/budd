import type { RateLimiter } from './RateLimiter.js';

interface Bucket {
  tokens: number;
  updatedMs: number;
}

/**
 * Classic token bucket: `capacity` tokens, refilled continuously over `windowMs`.
 * When keys come from untrusted input (client addresses), pass `maxKeys`: at
 * most that many buckets are kept, and beyond it the least recently used
 * tenth is dropped (and so refills to full). Dropping in batches keeps
 * eviction cheap: V8 scans past deleted Map slots to find the oldest key.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    windowMs: number,
    private readonly maxKeys = Infinity,
  ) {
    this.refillPerMs = capacity / windowMs;
  }

  tryConsume(key: string, nowMs: number = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedMs: nowMs };
    const elapsed = Math.max(0, nowMs - bucket.updatedMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedMs = nowMs;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.delete(key); // re-inserted below, so Map order is least recently used first
    if (bucket.tokens < this.capacity) {
      this.buckets.set(key, bucket); // full buckets carry no state
      if (this.buckets.size > this.maxKeys) {
        let evict = Math.ceil(this.maxKeys / 10);
        for (const oldest of this.buckets.keys()) {
          this.buckets.delete(oldest);
          if (--evict === 0) break;
        }
      }
    }
    return allowed;
  }
}
