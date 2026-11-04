import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';
import { OAUTH_API_PATHS, sendOAuthError } from '../auth/oauth.js';
import { log, throttledLog } from '../log.js';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';
import { clientIp, hasForwardingHeaders, isInternalAddress, rateLimitKey } from './clientIp.js';

/** Hosted mode's endpoints that anyone can call without a token or session. */
const PUBLIC_PATHS = [
  ...OAUTH_API_PATHS,
  '/authorize',
  '/login',
  '/console/login',
  '/auth/callback',
];

/** Dynamic Client Registration is open to anyone, so it is limited instance-wide. */
const REGISTRATIONS_PER_MIN = 30;
/**
 * And per address, well below that, so a few addresses can't use up
 * everyone's quota. Real apps register once.
 */
const REGISTRATIONS_PER_ADDRESS_PER_MIN = 5;

/** Addresses can come from a forged header, so the number tracked is capped. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * Hosted mode: rate limits on the public endpoints, so no one source can
 * flood them, and a flood of registrations can't fill the database.
 *
 * Budd limits an address only when it can tell clients apart: a well-formed
 * CLIENT_IP_HEADER value, or a public socket address (Budd faces clients
 * directly). A loopback or private socket address with no header means a
 * proxy, tunnel or Docker bridge is in front, and limiting it would put every
 * user in one bucket that one attacker could empty. Such requests aren't
 * limited per address. Budd logs once when the setup looks wrong: no
 * CLIENT_IP_HEADER behind a proxy, a proxy that doesn't send it, or a header
 * trusted from a public address.
 *
 * Budd trusts CLIENT_IP_HEADER as given, so only the proxy must be able to
 * set it. If clients can reach Budd or the proxy some other way, a forged
 * header gets around the per-address limit, or names someone else's address
 * to lock them out of signing in. The instance-wide registration limit
 * applies regardless.
 */
export function mountRateLimits(app: Hono, config: Config, clock: () => number): void {
  const header = config.hosted?.clientIpHeader;
  const perAddress = (perMin: number) =>
    new TokenBucketRateLimiter(perMin, 60_000, MAX_TRACKED_ADDRESSES);
  const general = perAddress(config.limits.ipRatePerMin);
  const registrations = perAddress(REGISTRATIONS_PER_ADDRESS_PER_MIN);
  const allRegistrations = new TokenBucketRateLimiter(REGISTRATIONS_PER_MIN, 60_000);
  // One line per address per minute, and a flood of addresses can't flood the log.
  const loggedAddresses = perAddress(1);
  const logRefusal = throttledLog(60, clock);

  const refuse = (c: Context, message: string) => {
    c.header('Retry-After', '60');
    if (!OAUTH_API_PATHS.includes(c.req.path)) return c.text(`${message}\n`, 429);
    // Refused before the CORS middleware runs, so browser clients can read the 429.
    c.header('Access-Control-Allow-Origin', '*');
    // No OAuth error code means "rate limited"; clients go by the 429 and
    // Retry-After. temporarily_unavailable (not server_error) also keeps the MCP
    // SDK from answering a refused refresh by starting a whole new sign-in.
    return sendOAuthError(c, 429, 'temporarily_unavailable', message);
  };
  const refuseAddress = (c: Context, key: string) => {
    if (loggedAddresses.tryConsume(key, clock())) {
      logRefusal('warn', 'rate limited', { client: key, path: c.req.path });
    }
    return refuse(c, 'Too many requests from your address; try again in a minute.');
  };

  // Each setup problem is logged once: they're about configuration, not traffic.
  const hinted = new Set<string>();
  const hintOnce = (kind: string, level: 'info' | 'warn', msg: string, from: string) => {
    if (hinted.has(kind)) return;
    hinted.add(kind);
    log[level](`${msg} (docs/operating.md, "Putting Budd on the internet")`, { from });
  };
  const checkSetup = (
    c: Context,
    socket: string,
    behindProxy: boolean,
    forwarded: string | undefined,
  ) => {
    if (header === undefined && behindProxy) {
      hintOnce(
        'unset',
        'info',
        'requests arrive through a proxy, tunnel or Docker network: set CLIENT_IP_HEADER so rate limits apply per client',
        socket,
      );
    } else if (header === undefined && !hinted.has('unset-public') && hasForwardingHeaders(c)) {
      hintOnce(
        'unset-public',
        'warn',
        `requests from ${socket} carry proxy forwarding headers: if ${socket} is your proxy, set CLIENT_IP_HEADER, or every user shares its rate limit. If Budd faces clients directly, ignore this: clients can send these headers themselves, so don't set CLIENT_IP_HEADER`,
        socket,
      );
    } else if (header !== undefined && forwarded === undefined && behindProxy) {
      hintOnce(
        'missing',
        'warn',
        `CLIENT_IP_HEADER is ${header}, but a request arrived without a usable ${header} value, so it isn't rate limited per client: check that the proxy sets that header`,
        socket,
      );
    } else if (header !== undefined && forwarded !== undefined && !behindProxy) {
      hintOnce(
        'trusted-public',
        'warn',
        `CLIENT_IP_HEADER was trusted on a request from ${socket}, a public address: if that isn't your proxy, Budd can be reached directly and anyone can forge ${header}`,
        socket,
      );
    }
  };

  const limit: MiddlewareHandler = async (c, next) => {
    // A browser's CORS preflight comes with every OAuth call; count the call once.
    if (c.req.method === 'OPTIONS') return next();
    const registering = c.req.path === '/register' && c.req.method === 'POST';
    const { socket, forwarded } = clientIp(c, header);
    const behindProxy = isInternalAddress(socket);
    checkSetup(c, socket, behindProxy, forwarded);
    // An internal socket with no usable header is a proxy, not a client.
    const ip = forwarded ?? (behindProxy ? undefined : socket);
    const now = clock();
    if (ip !== undefined) {
      const key = rateLimitKey(ip);
      if (!general.tryConsume(key, now)) return refuseAddress(c, key);
      if (registering && !registrations.tryConsume(key, now)) return refuseAddress(c, key);
    }
    // After the per-address limits, so an address over its limit doesn't drain the shared quota.
    if (registering && !allRegistrations.tryConsume('register', now)) {
      logRefusal('warn', 'client registration refused', { error: 'temporarily_unavailable' });
      return refuse(c, 'Too many registrations; try again in a minute.');
    }
    return next();
  };
  for (const path of PUBLIC_PATHS) app.use(path, limit);
}
