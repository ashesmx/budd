import { afterEach, describe, expect, it } from 'vitest';
import { startHostedBudd } from './helpers/hosted.js';
import { startTestBudd, type TestBudd } from './helpers/harness.js';
import { safeReturnPath } from '../src/ui/web.js';

let budd: TestBudd | undefined;
afterEach(async () => {
  await budd?.close();
  budd = undefined;
});

const big = (bytes: number) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'x'.repeat(bytes) } });

describe('request size limits', () => {
  it('refuses MCP bodies over four times the message limit before parsing them', async () => {
    budd = await startTestBudd({ MAX_MESSAGE_BYTES: String(64 * 1024) });
    const post = (bytes: number) =>
      fetch(`${budd?.url ?? ''}/mcp/claude-desktop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: big(bytes),
      });
    expect((await post(300 * 1024)).status).not.toBe(413);
    expect((await post(330 * 1024)).status).toBe(413);
  });

  it('refuses a tool call with more elements than any valid send', async () => {
    budd = await startTestBudd({ MAX_MESSAGE_BYTES: '1000' });
    const agent = await budd.connect('claude-desktop');
    const r = await agent.call('send', {
      to: ['claude-desktop/cos'],
      from_handle: 'cos',
      payload: { list: Array.from({ length: 1000 }, () => 0) },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('maximum of');
  });

  it('also refuses an oversized chunked (streamed) body', async () => {
    budd = await startTestBudd();
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await fetch(`${budd.url}/mcp/claude-desktop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
  });

  it('refuses UI form bodies over 64 KiB', async () => {
    budd = await startTestBudd();
    const res = await fetch(`${budd.url}/ui/connections/x/label`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `label=${'x'.repeat(100 * 1024)}`,
    });
    expect(res.status).toBe(413);
  });

  it('caps recipients per send at what a sender may have outstanding', async () => {
    budd = await startTestBudd({ SENDER_MAX_OUTSTANDING: '3' });
    const agent = await budd.connect('claude-desktop');
    const r = await agent.call('send', {
      to: ['a/b', 'c/d', 'e/f', 'g/h'],
      from_handle: 'cos',
      body_md: 'x',
    });
    expect(r.isError).toBe(true);
  });
});

describe('hosted sessions', () => {
  it('creates no session for anonymous visitors', async () => {
    const hosted = await startHostedBudd();
    budd = hosted;
    for (const p of ['/ui', '/ui/messages', '/login?return=/ui']) {
      const res = await fetch(hosted.url + p, { redirect: 'manual' });
      expect(
        res.headers.getSetCookie().filter((c) => c.startsWith('budd_session')),
        p,
      ).toEqual([]);
    }
  });
});

describe('return paths after sign-in (no open redirect)', () => {
  it.each([
    ['/ui', '/ui'],
    ['/ui/audit?page=2', '/ui/audit?page=2'],
    ['/authorize?client_id=x&state=y', '/authorize?client_id=x&state=y'],
  ])('keeps the same-site path %s', (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '\t//evil.example',
    '/..//evil.example',
    '/.//evil.example',
    '/%2e%2e//evil.example',
    '/%2e//evil.example',
    '/ui/..//evil.example',
    '/./\\evil.example',
    '/..\\/evil.example',
    'ui',
  ])('falls back to /ui for %j', (raw) => {
    expect(safeReturnPath(raw)).toBe('/ui');
  });

  it('refuses a tab-split path at /login (redirects to /ui, not off-site)', async () => {
    budd = await startTestBudd();
    const res = await fetch(`${budd.url}/login?return=/%09/evil.example`, { redirect: 'manual' });
    const body = await res.text();
    expect(res.headers.get('location') ?? '').not.toContain('evil');
    expect(body).not.toContain('evil.example');
  });
});

describe('HSTS', () => {
  it('is sent when PUBLIC_URL is https, and not over plain http', async () => {
    const tls = await startHostedBudd({ PUBLIC_URL: 'https://budd.corp.test' });
    try {
      const res = await fetch(`${tls.url}/health`);
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    } finally {
      await tls.close();
    }
    const plain = await startHostedBudd();
    try {
      const res = await fetch(`${plain.url}/health`);
      expect(res.headers.get('strict-transport-security')).toBeNull();
    } finally {
      await plain.close();
    }
  });
});
