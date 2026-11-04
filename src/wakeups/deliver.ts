import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { BUDD_VERSION } from '../version.js';

/**
 * Sending a wake-up: one HTTPS POST to an address a human gave, which makes it
 * a way for Budd to reach networks it shouldn't (SSRF). So: HTTPS only, no
 * credentials in the URL, every address the name resolves to must be public,
 * and the connection goes to the address that was checked. No redirects, a
 * short timeout, and nothing kept but the status.
 */

/**
 * Addresses that aren't the public internet: private, loopback, link-local,
 * CGNAT, multicast, reserved. One list per family: Node matches IPv4 addresses
 * against IPv6 rules too, so `::ffff:0:0/96` in a shared list would refuse all.
 */
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped: would reach IPv4 around the checks above
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23], // IETF special purpose, Teredo included
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6');
}
/** Global unicast IPv6 is only 2000::/3; anything else is reserved. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC_V4.check(address, 'ipv4');
  if (family === 6) {
    return GLOBAL_V6.check(address, 'ipv6') && !NOT_PUBLIC_V6.check(address, 'ipv6');
  }
  return false;
}

/** A host as the URL parser gives it, without IPv6 brackets or a trailing dot. */
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** Names that are never on the public internet, whatever they resolve to. */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|lan|home|arpa)$/i;

/** A wake-up's address, or why it can't be one. Said to the human who typed it. */
export function checkUrl(raw: string): { url: URL } | { error: string } {
  if (raw.length > 2048) return { error: 'The address is too long.' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      error: 'That isn’t a web address. Paste the whole https:// address your platform gave you.',
    };
  }
  if (url.protocol !== 'https:') return { error: 'The address must start with https://.' };
  if (url.username || url.password) {
    return { error: 'Put the token in the Token box, not in the address.' };
  }
  if (url.hash) return { error: 'The address can’t have a # part.' };
  // Every platform listens on 443; other ports would let Budd probe services that aren't web hooks.
  if (url.port !== '')
    return { error: 'The address can’t name a port: Budd sends only to the usual https port.' };
  const host = bareHost(url);
  if (isIP(host) ? !isPublicAddress(host) : !host.includes('.') || PRIVATE_NAME.test(host)) {
    return {
      error: 'The address must be on the public internet: Budd won’t wake private networks.',
    };
  }
  return { url };
}

/** A token as sent in the Authorization header: visible ASCII only. */
export const isHeaderSafe = (token: string) => /^[\x21-\x7e]+$/.test(token);

/** What happened, in a few words a person can act on, and whether the platform took it. Only this is kept. */
export type Outcome = { ok: boolean; status: string };

export interface WakeUpRequest {
  url: string;
  token: string | null;
  /** Signs the body, both GitHub-style and as Standard Webhooks, when set. */
  signingSecret: string | null;
  body: string;
  /** This wake-up's own id, sent as `Idempotency-Key` so a platform runs it once. */
  id: string;
}

/** `sha256=<hex HMAC-SHA256 of the body>`, as GitHub and Multica check it. */
export const signature = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Standard Webhooks (what Grok checks): `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`.
 * A `whsec_` secret is base64 after its prefix; any other is used as typed.
 */
export const standardSignature = (secret: string, id: string, timestamp: number, body: string) => {
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret);
  const signed = `${id}.${String(timestamp)}.${body}`;
  return `v1,${createHmac('sha256', key).update(signed).digest('base64')}`;
};

/** The signature headers for both schemes, so the platform checks whichever it knows. */
const signatureHeaders = (secret: string, id: string, body: string) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-hub-signature-256': signature(secret, body),
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': standardSignature(secret, id, timestamp, body),
  };
};

/** Sends one wake-up. Never throws: every failure is an outcome. */
export type Deliver = (req: WakeUpRequest) => Promise<Outcome>;

const TIMEOUT_MS = 10_000;

/**
 * Its own agent, so the connection always goes straight to the checked
 * address: never through a proxy (NODE_USE_ENV_PROXY would make Node's global
 * agent use HTTPS_PROXY), which would resolve the name again itself.
 */
const DIRECT = new Agent({ keepAlive: false });

/** Network errors, said coarsely: enough to fix a setup, not enough to map someone's network. */
const failure = (err: NodeJS.ErrnoException): string =>
  /CERT|SSL|TLS|ALTNAME|SELF_SIGNED|EPROTO/.test(err.code ?? '')
    ? 'failed: its https certificate isn’t valid'
    : 'failed: couldn’t connect';

/**
 * Within TIMEOUT_MS from start to finish, lookup included, however slowly the
 * other end answers: a stalled wake-up must never hold up anything else.
 */
export const deliver: Deliver = (req) =>
  new Promise<Outcome>((resolve) => {
    // Aborting ends the request, or stops one that hasn't started when a slow lookup returns.
    const stop = new AbortController();
    const done = (outcome: Outcome) => {
      clearTimeout(deadline);
      stop.abort();
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      done({ ok: false, status: `failed: no answer in ${String(TIMEOUT_MS / 1000)} seconds` });
    }, TIMEOUT_MS);
    send(req, stop.signal).then(done, () => {
      done({ ok: false, status: 'failed: couldn’t connect' });
    });
  });

async function send(
  { url: raw, token, signingSecret, body, id }: WakeUpRequest,
  signal: AbortSignal,
): Promise<Outcome> {
  const checked = checkUrl(raw);
  if ('error' in checked) return { ok: false, status: 'refused: not a public https address' };
  if (token !== null && !isHeaderSafe(token))
    return { ok: false, status: 'refused: the token has characters a header can’t carry' };
  const { url } = checked;
  const host = bareHost(url);
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, order: 'verbatim' });
  } catch {
    return { ok: false, status: 'failed: the name doesn’t resolve' };
  }
  // Every address, not just the first: a name mixing public and private ones is refused.
  const target = addresses[0];
  if (!target || addresses.some((a) => !isPublicAddress(a.address))) {
    return { ok: false, status: 'refused: it resolves to a private address' };
  }
  if (signal.aborted) return { ok: false, status: 'failed: no answer' };
  // request() throws for a bad header: the caller turns that into an outcome.
  return new Promise<Outcome>((resolve) => {
    const r = request(
      url,
      {
        method: 'POST',
        agent: DIRECT,
        signal,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': `Budd/${BUDD_VERSION} (wake-up)`,
          'idempotency-key': id,
          ...(token !== null && { authorization: `Bearer ${token}` }),
          ...(signingSecret !== null && signatureHeaders(signingSecret, id, body)),
          // Claude Code routines' API requires a version header.
          ...(host === 'api.anthropic.com' && { 'anthropic-version': '2023-06-01' }),
        },
        // Connect to the address that was checked, never a second lookup's answer.
        lookup: (_name, opts, cb) => {
          if ((opts as { all?: boolean }).all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        const code = res.statusCode ?? 0;
        res.destroy(); // the body is never read
        resolve({ ok: code >= 200 && code < 300, status: `HTTP ${String(code)}` });
      },
    );
    r.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, status: failure(err) });
    });
    r.end(body);
  });
}
