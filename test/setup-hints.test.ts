import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHostedBudd, type HostedBudd } from './helpers/hosted.js';

// Tests connect from 127.0.0.1; these pretend the socket is a public address,
// as when Budd faces the internet or a proxy reaches it over one.
const socket = vi.hoisted(() => ({ address: '203.0.113.50' }));
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: socket.address } }),
}));

let budd: HostedBudd | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await budd?.close();
  budd = undefined;
});

const logLines = () => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => lines.push(l));
  return lines;
};
const tokenFrom = (b: HostedBudd, headers: Record<string, string>) =>
  fetch(`${b.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: 'grant_type=authorization_code&code=x&client_id=nope',
  });

describe('setup warnings from a public socket address', () => {
  it('a proxy that isn’t configured: logs once that CLIENT_IP_HEADER should be set', async () => {
    const lines = logLines();
    budd = await startHostedBudd();
    await tokenFrom(budd, { 'x-forwarded-for': '198.51.100.1' });
    await tokenFrom(budd, { 'x-forwarded-for': '198.51.100.2' });
    const hints = lines.filter((l) => l.includes('carry proxy forwarding headers'));
    expect(hints).toHaveLength(1);
    // Strangers can send these headers too, so it mustn't push a direct setup into trusting them.
    expect(hints[0]).toContain('If Budd faces clients directly, ignore this');
  });

  it('a client facing Budd directly, without forwarding headers: no warning', async () => {
    const lines = logLines();
    budd = await startHostedBudd();
    await tokenFrom(budd, {});
    expect(lines.filter((l) => l.includes('CLIENT_IP_HEADER'))).toHaveLength(0);
  });

  it('a header trusted from a public address: logs once that it could be forged', async () => {
    const lines = logLines();
    budd = await startHostedBudd({ CLIENT_IP_HEADER: 'x-real-ip' });
    await tokenFrom(budd, { 'x-real-ip': '198.51.100.1' });
    await tokenFrom(budd, { 'x-real-ip': '198.51.100.2' });
    expect(lines.filter((l) => l.includes('anyone can forge x-real-ip'))).toHaveLength(1);
  });

  it('limits a public socket address when there is no header', async () => {
    budd = await startHostedBudd({ IP_RATE_PER_MIN: '1' });
    expect((await tokenFrom(budd, {})).status).not.toBe(429);
    expect((await tokenFrom(budd, {})).status).toBe(429);
  });
});
