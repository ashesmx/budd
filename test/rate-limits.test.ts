import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { throttledLog } from '../src/log.js';
import { isInternalAddress, rateLimitKey } from '../src/http/clientIp.js';
import { TokenBucketRateLimiter } from '../src/ratelimit/TokenBucketRateLimiter.js';
import { startHostedBudd, type HostedBudd } from './helpers/hosted.js';
import { startTestBudd } from './helpers/harness.js';

let budd: HostedBudd | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await budd?.close();
  budd = undefined;
});

// Tests connect from 127.0.0.1, which Budd reads as "behind a proxy", so they
// send the client's address in a header, as a proxy would.
const from = (ip: string) => ({ 'x-real-ip': ip });

const tokenFrom = (b: HostedBudd, headers: Record<string, string> = {}) =>
  fetch(`${b.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: 'grant_type=authorization_code&code=x&client_id=nope',
  });

const registerFrom = (b: HostedBudd, headers: Record<string, string>) =>
  fetch(`${b.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      client_name: 'x',
      redirect_uris: ['http://127.0.0.1:1/cb'],
      token_endpoint_auth_method: 'none',
    }),
  });

describe('per-address rate limits (hosted)', () => {
  it('limits one address on the public endpoints, then refills', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '3', CLIENT_IP_HEADER: 'x-real-ip' });
    const a = from('198.51.100.1');
    for (let i = 0; i < 3; i++) expect((await tokenFrom(budd, a)).status).not.toBe(429);
    const limited = await tokenFrom(budd, a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
    // Shared across the public endpoints: the browser ones refuse too, as a page.
    const page = await fetch(`${budd.url}/login`, { headers: a, redirect: 'manual' });
    expect(page.status).toBe(429);
    expect(page.headers.get('content-type')).toMatch(/text\/plain/);
    // The console's sign-in too: each one holds a pending login, as /login's does.
    const consoleLogin = await fetch(`${budd.url}/console/login`, {
      method: 'POST',
      headers: { ...a, origin: budd.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'return=/console',
      redirect: 'manual',
    });
    expect(consoleLogin.status).toBe(429);
    budd.clock.now += 60_000;
    expect((await tokenFrom(budd, a)).status).not.toBe(429);
  });

  it('limits each client address separately', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '2', CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    const a = { 'cf-connecting-ip': '198.51.100.1' };
    await tokenFrom(budd, a);
    await tokenFrom(budd, a);
    expect((await tokenFrom(budd, a)).status).toBe(429);
    expect((await tokenFrom(budd, { 'cf-connecting-ip': '2001:db8::1' })).status).not.toBe(429);
  });

  it('limits IPv6 per /64, so a host can’t rotate addresses within its prefix', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '2', CLIENT_IP_HEADER: 'x-real-ip' });
    await tokenFrom(budd, from('2001:db8:1:2::a'));
    await tokenFrom(budd, from('2001:db8:1:2::b'));
    expect((await tokenFrom(budd, from('2001:db8:1:2:ffff::c'))).status).toBe(429);
    expect((await tokenFrom(budd, from('2001:db8:1:3::a'))).status).not.toBe(429);
  });

  it('doesn’t limit health, metadata or MCP', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1', CLIENT_IP_HEADER: 'x-real-ip' });
    const a = from('198.51.100.1');
    await tokenFrom(budd, a);
    expect((await tokenFrom(budd, a)).status).toBe(429);
    expect((await fetch(`${budd.url}/health`, { headers: a })).status).toBe(200);
    expect(
      (await fetch(`${budd.url}/.well-known/oauth-authorization-server`, { headers: a })).status,
    ).toBe(200);
    expect((await fetch(`${budd.url}/mcp`, { method: 'POST', headers: a })).status).toBe(401);
  });

  it('takes the last X-Forwarded-For entry (the one the proxy added)', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1', CLIENT_IP_HEADER: 'x-forwarded-for' });
    // A client rotating a forged first entry is still one address to the proxy.
    const first = await tokenFrom(budd, { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' });
    expect(first.status).not.toBe(429);
    const second = await tokenFrom(budd, { 'x-forwarded-for': '2.2.2.2, 203.0.113.9' });
    expect(second.status).toBe(429);
  });

  it('reads an address that comes with a port, as some load balancers send it', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1', CLIENT_IP_HEADER: 'x-real-ip' });
    expect((await tokenFrom(budd, from('203.0.113.9:5678'))).status).not.toBe(429);
    expect((await tokenFrom(budd, from('203.0.113.9:6789'))).status).toBe(429);
    expect((await tokenFrom(budd, from('[2001:db8::1]:443'))).status).not.toBe(429);
    expect((await tokenFrom(budd, from('2001:db8::2'))).status).toBe(429);
  });

  it('doesn’t count CORS preflights, and browser clients can read the refusal', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1', CLIENT_IP_HEADER: 'x-real-ip' });
    const a = from('198.51.100.1');
    const preflight = { method: 'OPTIONS', headers: { ...a, origin: 'https://app.test' } };
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${budd.url}/token`, preflight)).status).toBe(204);
    }
    expect((await tokenFrom(budd, a)).status).not.toBe(429);
    const limited = await tokenFrom(budd, a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');
    expect(limited.headers.get('cache-control')).toBe('no-store');
  });

  it('limits registrations per address below the instance-wide limit', async () => {
    budd = await startHostedBudd({ CLIENT_IP_HEADER: 'x-real-ip' });
    const one = from('198.51.100.7');
    for (let i = 0; i < 5; i++) expect((await registerFrom(budd, one)).status).toBe(201);
    expect((await registerFrom(budd, one)).status).toBe(429);
    // Another address can still register: one source can't use up everyone's quota.
    expect((await registerFrom(budd, from('198.51.100.8'))).status).toBe(201);
  });

  it('still applies the instance-wide registration limit to many addresses', async () => {
    budd = await startHostedBudd({ CLIENT_IP_HEADER: 'x-real-ip' });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await registerFrom(budd, from(`198.51.100.${String(i + 10)}`))).status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    const last = await registerFrom(budd, from('198.51.100.200'));
    expect(last.headers.get('retry-after')).toBe('60');
    expect(await last.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });
});

describe('behind a proxy without CLIENT_IP_HEADER', () => {
  it('doesn’t put everyone in one bucket (one attacker can’t lock everyone out)', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1' }); // sockets are 127.0.0.1
    for (let i = 0; i < 5; i++) expect((await tokenFrom(budd)).status).not.toBe(429);
  });

  it('ignores client-supplied address headers (they could be forged)', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1' });
    for (let i = 0; i < 3; i++) {
      expect((await tokenFrom(budd, { 'x-forwarded-for': '198.51.100.1' })).status).not.toBe(429);
    }
  });

  it('logs once that CLIENT_IP_HEADER should be set', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    budd = await startHostedBudd();
    await tokenFrom(budd);
    await tokenFrom(budd);
    expect(lines.filter((l) => l.includes('set CLIENT_IP_HEADER'))).toHaveLength(1);
  });

  it('logs once when CLIENT_IP_HEADER is set but the proxy doesn’t send it', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    budd = await startHostedBudd({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
    await tokenFrom(budd, { 'x-forwarded-for': '198.51.100.1' });
    await tokenFrom(budd, { 'x-forwarded-for': '198.51.100.1' });
    expect(lines.filter((l) => l.includes('check that the proxy sets that header'))).toHaveLength(
      1,
    );
  });

  it('still limits registrations instance-wide', async () => {
    budd = await startHostedBudd();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await registerFrom(budd, {})).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });

  it('a malformed header value falls back to the socket (here: not limited)', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1', CLIENT_IP_HEADER: 'x-real-ip' });
    for (let i = 0; i < 3; i++) {
      expect((await tokenFrom(budd, from('<script>'))).status).not.toBe(429);
    }
  });
});

describe('local mode', () => {
  it('has no per-address limit', async () => {
    const local = await startTestBudd({ IP_RATE_PER_MIN: '1' });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await fetch(`${local.url}/login`, { redirect: 'manual' })).status).not.toBe(429);
      }
    } finally {
      await local.close();
    }
  });
});

describe('addresses', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.17.0.1', true], // Docker's bridge
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.1.1', true],
    ['100.100.1.1', true], // carrier-grade NAT, Tailscale
    ['100.128.0.1', false],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:10.0.0.1', true],
    ['not an address', false],
    ['198.51.100.1', false],
    ['2001:db8::1', false],
    ['::ffff:198.51.100.1', false],
  ])('%s is internal: %s', (ip, internal) => {
    expect(isInternalAddress(ip)).toBe(internal);
  });

  it.each([
    ['198.51.100.1', '198.51.100.1'],
    ['::ffff:198.51.100.1', '198.51.100.1'],
    ['2001:db8:1:2::a', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff:0:0:1', '2001:db8:1:2::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::ffff:0:c633:6401', '0:0:0:0::/64'],
  ])('%s is keyed as %s', (ip, key) => {
    expect(rateLimitKey(ip)).toBe(key);
  });
});

describe('CLIENT_IP_HEADER and IP_RATE_PER_MIN configuration', () => {
  const hosted = {
    BUDD_MODE: 'hosted',
    PUBLIC_URL: 'https://budd.corp.test',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    OPEN_SIGNUP: 'true',
  };
  it('normalises the header name and treats empty as unset', () => {
    expect(
      loadConfig({ ...hosted, CLIENT_IP_HEADER: ' CF-Connecting-IP ' }).hosted?.clientIpHeader,
    ).toBe('cf-connecting-ip');
    expect(loadConfig({ ...hosted, CLIENT_IP_HEADER: '' }).hosted?.clientIpHeader).toBeUndefined();
    expect(loadConfig(hosted).limits.ipRatePerMin).toBe(120);
  });
  it('refuses a value that isn’t a header name, and a non-positive rate', () => {
    expect(() => loadConfig({ ...hosted, CLIENT_IP_HEADER: 'X-Real-IP: 1.2.3.4' })).toThrow(
      /CLIENT_IP_HEADER: must be a header name/,
    );
    expect(() => loadConfig({ ...hosted, IP_RATE_PER_MIN: '0' })).toThrow(/IP_RATE_PER_MIN/);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('with maxKeys, keeps at most that many buckets, dropping the least recently used', () => {
    const limiter = new TokenBucketRateLimiter(1, 60_000, 2);
    expect(limiter.tryConsume('a', 0)).toBe(true);
    expect(limiter.tryConsume('b', 0)).toBe(true);
    expect(limiter.tryConsume('a', 0)).toBe(false); // a is now the most recent
    expect(limiter.tryConsume('c', 0)).toBe(true); // evicts b
    expect(limiter.tryConsume('a', 0)).toBe(false); // a kept
    expect(limiter.tryConsume('b', 0)).toBe(true); // b forgotten, so full again
  });

  it('without maxKeys, never forgets a limited key (e.g. per-connection send limits)', () => {
    const limiter = new TokenBucketRateLimiter(1, 60_000);
    expect(limiter.tryConsume('limited', 0)).toBe(true);
    for (let i = 0; i < 20_000; i++) limiter.tryConsume(`k${String(i)}`, 0);
    expect(limiter.tryConsume('limited', 0)).toBe(false);
  });
});

describe('throttledLog', () => {
  it('logs at most perMin lines a minute, then says how many it dropped', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    const logIt = throttledLog(2, () => 0);
    for (let i = 0; i < 5; i++) logIt('warn', 'refused');
    expect(lines).toHaveLength(2);
    // Reported even when the flood has stopped.
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ msg: 'refused', dropped: 3 });
  });

  it('keeps a separate budget per message, so one flood can’t hide other lines', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    const logIt = throttledLog(1, () => 0);
    for (let i = 0; i < 5; i++) logIt('info', 'no token');
    logIt('warn', 'token rejected');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual([
      'no token',
      'token rejected',
    ]);
  });
});

describe('refusals anyone can cause', () => {
  it('log short lines, however long the request’s fields', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    budd = await startHostedBudd();
    const huge = 'A'.repeat(30_000); // two of these fit under the 64 KiB body limit
    await fetch(`${budd.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${huge}&client_id=${huge}`,
    });
    await fetch(`${budd.url}/authorize?client_id=${'B'.repeat(10_000)}`);
    expect(lines.some((l) => l.includes('token request refused'))).toBe(true);
    expect(lines.some((l) => l.includes('authorize refused'))).toBe(true);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(1_000);
  });

  it('are capped per kind, like every line a stranger can cause', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    budd = await startHostedBudd();
    for (let i = 0; i < 70; i++) await tokenFrom(budd);
    expect(lines.filter((l) => l.includes('token request refused'))).toHaveLength(60);
  });
});

describe('unauthenticated /mcp requests', () => {
  it('a flood doesn’t flood the log', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
    budd = await startHostedBudd();
    for (let i = 0; i < 70; i++) {
      expect((await fetch(`${budd.url}/mcp`, { method: 'POST' })).status).toBe(401);
    }
    expect(lines.filter((l) => l.includes('mcp request without a token'))).toHaveLength(60);
  });
});

describe('request limits per connection and per browser session', () => {
  it('limits each MCP connection separately (MCP_RATE_PER_MIN)', async () => {
    const local = await startTestBudd({ MCP_RATE_PER_MIN: '3' });
    try {
      const list = (name: string) =>
        fetch(`${local.url}/mcp/${name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
      for (let i = 0; i < 3; i++) expect((await list('claude-desktop')).status).toBe(200);
      const limited = await list('claude-desktop');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.text()).toContain('MCP_RATE_PER_MIN');
      expect((await list('grok-build')).status).toBe(200);
    } finally {
      await local.close();
    }
  });

  it('refuses JSON-RPC batches, which would pass 100 calls as one request', async () => {
    const local = await startTestBudd();
    try {
      const call = { jsonrpc: '2.0', method: 'tools/list' };
      const res = await fetch(`${local.url}/mcp/claude-desktop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify([
          { ...call, id: 1 },
          { ...call, id: 2 },
        ]),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/one JSON-RPC message per request/);
    } finally {
      await local.close();
    }
  });

  it('limits each browser session (UI_RATE_PER_MIN)', async () => {
    const local = await startTestBudd({ UI_RATE_PER_MIN: '3' });
    try {
      const cookie = await local.uiCookie();
      const page = (as = cookie) =>
        fetch(`${local.url}/ui/audit`, { headers: { cookie: as }, redirect: 'manual' });
      for (let i = 0; i < 3; i++) expect((await page()).status).toBe(200);
      expect((await page()).status).toBe(429);
      expect((await page(await local.uiCookie())).status).toBe(200);
    } finally {
      await local.close();
    }
  });
});
