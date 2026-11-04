import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBudd, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
beforeAll(async () => {
  budd = await startTestBudd();
});
afterAll(async () => {
  await budd.close();
});

/** Raw HTTP so tests can set any Host header (fetch forbids overriding it). */
function request(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const url = new URL(budd.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body !== undefined && {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          }),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};

describe('local mode Host/Origin checks (DNS-rebinding protection)', () => {
  it.each(['evil.example.com', 'evil.example.com:8787', '192.168.1.10:8787', '0.0.0.0'])(
    'rejects Host %j',
    async (host) => {
      const mcp = await request('/mcp/claude-desktop', { host }, initialize);
      expect(mcp.status).toBe(403);
      const health = await request('/health', { host });
      expect(health.status).toBe(403);
    },
  );

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts loopback Host %j', async (hostname) => {
    const res = await request(
      '/mcp/claude-desktop',
      { host: `${hostname}:${new URL(budd.url).port}` },
      initialize,
    );
    expect(res.status).toBe(200);
  });

  it.each(['https://evil.example.com', 'http://localhost.evil.com', 'null', 'file://'])(
    'rejects Origin %j',
    async (origin) => {
      const res = await request('/mcp/claude-desktop', { origin }, initialize);
      expect(res.status).toBe(403);
    },
  );

  it('accepts a loopback Origin and no Origin at all', async () => {
    expect(
      (await request('/mcp/claude-desktop', { origin: 'http://localhost:3000' }, initialize))
        .status,
    ).toBe(200);
    expect((await request('/mcp/claude-desktop', {}, initialize)).status).toBe(200);
  });
});

describe('connection identity from the URL path', () => {
  it('rejects a bare /mcp with a helpful message', async () => {
    for (const path of ['/mcp', '/mcp/']) {
      const res = await request(path, {}, initialize);
      expect(res.status).toBe(400);
      expect(res.body).toMatch(
        /Add a connection name to the URL, e\.g\. http:\/\/.*\/mcp\/claude-desktop/,
      );
    }
  });

  it.each(['A', 'x', 'Claude-Desktop', 'claude_desktop', 'a'.repeat(41)])(
    'rejects invalid connection name %j',
    async (name) => {
      const res = await request(`/mcp/${name}`, {}, initialize);
      expect(res.status).toBe(400);
      expect(res.body).toMatch(/not a valid connection name/);
    },
  );

  it('rejects reserved connection names', async () => {
    const res = await request('/mcp/budd', {}, initialize);
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/reserved/);
  });

  it('rejects nested paths', async () => {
    const res = await request('/mcp/claude-desktop/extra', {}, initialize);
    expect(res.status).toBe(400);
  });

  it('auto-registers a connection on first contact', async () => {
    const agent = await budd.connect('first-contact');
    const me = await agent.ok('whoami');
    expect(me).toMatchObject({
      workspace: 'local',
      connection: 'first-contact',
      connection_verified: true,
    });
    const other = await budd.connect('observer');
    const list = await other.ok('list_connections');
    expect(list.connections.map((c: any) => c.connection)).toContain('first-contact');
  });
});

describe('local mode accepts only POST on /mcp/<connection>', () => {
  it('refuses a cross-site GET (e.g. an <img>) without creating a connection', async () => {
    const r = await request('/mcp/drive-by-xyz', {
      host: new URL(budd.url).host,
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).toBe(405);
    const other = await budd.connect('observer');
    const list = await other.ok('list_connections');
    expect(list.connections.map((c: any) => c.connection)).not.toContain('drive-by-xyz');
  });

  it('refuses a cross-site POST even without an Origin header', async () => {
    const r = await request(
      '/mcp/drive-by-post',
      { host: new URL(budd.url).host, 'sec-fetch-site': 'cross-site' },
      initialize,
    );
    expect(r.status).toBe(403);
  });
});
