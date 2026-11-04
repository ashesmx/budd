import { TokenBucketRateLimiter } from './ratelimit/TokenBucketRateLimiter.js';

type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Minimal structured logger. Never log message bodies or payloads. */
export const log = {
  info: (msg: string, fields?: Fields) => {
    emit('info', msg, fields);
  },
  warn: (msg: string, fields?: Fields) => {
    emit('warn', msg, fields);
  },
  error: (msg: string, fields?: Fields) => {
    emit('error', msg, fields);
  },
};

/** Text from a request, shortened so one request can't write a huge log line. */
export const clip = (value: unknown, max = 100): string | undefined =>
  typeof value !== 'string' ? undefined : value.length > max ? `${value.slice(0, max)}…` : value;

/**
 * For events anyone can cause without signing in: each message is logged at
 * most `perMin` times a minute, so a flood can't rotate the useful lines out
 * of the logs. A minute after the first line dropped, one line with that
 * message says how many were.
 */
export function throttledLog(perMin: number, clock: () => number = Date.now) {
  const budget = new TokenBucketRateLimiter(perMin, 60_000); // keyed by message: a fixed few
  const dropped = new Map<string, number>();
  const reportDropped = (level: 'info' | 'warn', msg: string) => {
    emit(level, msg, { dropped: dropped.get(msg) });
    dropped.delete(msg);
  };
  return (level: 'info' | 'warn', msg: string, fields?: Fields): void => {
    if (budget.tryConsume(msg, clock())) {
      emit(level, msg, fields);
      return;
    }
    const n = dropped.get(msg) ?? 0;
    if (n === 0) setTimeout(reportDropped, 60_000, level, msg).unref();
    dropped.set(msg, n + 1);
  };
}
