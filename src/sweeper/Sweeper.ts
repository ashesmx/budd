/** A periodic maintenance job (delivery expiry, retention purge, audit purge). */
export interface SweepJob {
  name: string;
  run(now: Date): Promise<void>;
}

/**
 * Runs sweep jobs on a schedule. v1 uses an in-process timer, which is why Budd
 * is single-instance only: two replicas would each run every job.
 */
export interface Sweeper {
  register(job: SweepJob): void;
  start(): void;
  stop(): Promise<void>;
  /** Run every job once, sequentially. Used by the timer and by tests. */
  runOnce(now?: Date): Promise<void>;
}
