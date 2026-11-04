import type { MiddlewareHandler } from 'hono';
import { isLoopbackHost } from '../config.js';

/** Hostname part of a Host header: "127.0.0.1:8787" → "127.0.0.1", "[::1]:8787" → "::1". */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']'));
  return hostHeader.split(':')[0] ?? '';
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname);
  } catch {
    return false; // includes the opaque "null" origin
  }
}

/**
 * DNS-rebinding protection for local mode. Requests must be addressed to a
 * loopback host, and any browser Origin must be loopback too. Requests without
 * an Origin (MCP clients, curl) are allowed.
 */
export function localGuard(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!isLoopbackHost(hostnameOf(host))) {
      return c.text(
        `Forbidden: Budd (local mode) only accepts requests addressed to 127.0.0.1 or localhost, not "${host}".\n`,
        403,
      );
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      return c.text(`Forbidden: cross-origin request from "${origin}" refused.\n`, 403);
    }
    await next();
  };
}
