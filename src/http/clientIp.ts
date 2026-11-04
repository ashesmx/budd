import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Where a request came from: the connecting socket's address, and the address
 * in `header` (CLIENT_IP_HEADER) if it's set and well-formed. Behind a proxy
 * or tunnel every socket is the proxy's, so the header names where the proxy
 * puts the real address: `cf-connecting-ip` (Cloudflare), `x-real-ip`, or
 * `x-forwarded-for`, whose last entry is the one the nearest proxy added
 * (earlier entries are whatever the client sent).
 */
export function clientIp(
  c: Context,
  header: string | undefined,
): { socket: string; forwarded: string | undefined } {
  const socket = socketIp(c);
  if (header === undefined) return { socket, forwarded: undefined };
  const raw = c.req.header(header);
  const value = withoutPort(
    (header === 'x-forwarded-for' ? raw?.split(',').at(-1) : raw)?.trim() ?? '',
  );
  return { socket, forwarded: isIP(value) ? value : undefined };
}

/** Headers that mean a proxy is in front, whichever one it is. */
export const hasForwardingHeaders = (c: Context): boolean =>
  ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip'].some(
    (h) => c.req.header(h) !== undefined,
  );

/** Some load balancers add the client's port: `1.2.3.4:5678`, `[2001:db8::1]:443`. */
function withoutPort(value: string): string {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(value) ?? /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(value);
  return m?.[1] ?? value;
}

function socketIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // not served by @hono/node-server (e.g. app.request in tests)
  }
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) as plain IPv4. */
function unmapped(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it isn't one. */
function ipv6Groups(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.split('%')[0] ?? '';
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c2, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c2 << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (s: string) => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * The rate-limit key for an address. IPv6 hosts usually hold a whole /64 and
 * can pick a new address per request, so IPv6 is limited per /64.
 */
export function rateLimitKey(ip: string): string {
  const v4 = unmapped(ip);
  const groups = ipv6Groups(v4);
  return groups
    ? `${groups
        .slice(0, 4)
        .map((g) => g.toString(16))
        .join(':')}::/64`
    : v4;
}

const INTERNAL_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
] as const) {
  INTERNAL_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
INTERNAL_NETWORKS.addAddress('::1', 'ipv6');
INTERNAL_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
INTERNAL_NETWORKS.addSubnet('fe80::', 10, 'ipv6');

/**
 * Loopback, private (RFC 1918, IPv6 ULA), shared (carrier-grade NAT, also
 * used by Tailscale) or link-local: an address that, as a socket address,
 * means a proxy, a tunnel or Docker's bridge sits in front of Budd rather than
 * the client itself.
 */
export function isInternalAddress(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && INTERNAL_NETWORKS.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
