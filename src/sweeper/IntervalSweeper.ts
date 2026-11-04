import { log } from '../log.js';
import type { SweepJob, Sweeper } from './Sweeper.js';

export class IntervalSweeper implements Sweeper {
  private readonly jobs: SweepJob[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  register(job: SweepJob): void {
    this.jobs.push(job);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Skip a tick rather than overlap a slow run.
      if (!this.running) void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(now: Date = new Date(this.clock())): Promise<void> {
    const run = (async () => {
      for (const job of this.jobs) {
        try {
          await job.run(now);
        } catch (err) {
          log.error('sweep job failed', { job: job.name, error: String(err) });
        }
      }
    })();
    this.running = run;
    try {
      await run;
    } finally {
      this.running = undefined;
    }
  }
}
