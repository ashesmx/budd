import { afterEach, describe, expect, it } from 'vitest';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;

afterEach(async () => {
  await budd.close();
});

/** Starts Budd with `env`, three agents on open policies, and their handles claimed. */
async function setup(env: Record<string, string> = {}) {
  budd = await startTestBudd(env);
  const claude = await budd.connect('claude-desktop');
  const grok = await budd.connect('grok-build');
  const code = await budd.connect('claude-code');
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await grok.ok('inbox_count', { handle: 'writer' });
  await code.ok('inbox_count', { handle: 'reviewer' });
  for (const c of ['claude-desktop', 'grok-build', 'claude-code']) await budd.setPolicy(c, 'all');
  return { claude, grok, code };
}

const send = (agent: Agent, to: string[], from_handle = 'chief-of-staff') =>
  agent.call('send', { to, from_handle, body_md: 'hi' });

describe('send rate (default 5 per minute per connection)', () => {
  it('allows 5 sends, refuses the 6th entirely, then refills over time', async () => {
    const { claude, grok } = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await send(claude, ['grok-build/researcher'])).isError).toBe(false);
    }
    const sixth = await send(claude, ['grok-build/researcher']);
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toMatch(/^rate_limited: .*5 messages per minute/);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(5);

    budd.clock.now += 12_000; // one token refills every 12 s
    expect((await send(claude, ['grok-build/researcher'])).isError).toBe(false);
    expect((await send(claude, ['grok-build/researcher'])).isError).toBe(true);
  });

  it('is per connection, not per handle', async () => {
    const { claude, code } = await setup();
    for (let i = 0; i < 5; i++) await send(claude, ['grok-build/researcher'], `h${i}`);
    expect((await send(claude, ['grok-build/researcher'], 'fresh-handle')).text).toMatch(
      /^rate_limited/,
    );
    expect((await send(code, ['grok-build/researcher'], 'reviewer')).isError).toBe(false);
  });

  it('is configurable, and audited as a refusal once a minute however often it’s hit', async () => {
    const { claude } = await setup({ SEND_RATE_PER_MIN: '1' });
    await send(claude, ['grok-build/researcher']);
    for (let i = 0; i < 5; i++) {
      expect((await send(claude, ['grok-build/researcher'])).text).toMatch(/^rate_limited/);
    }
    const refusals = async () => (await budd.audit()).filter((e) => e.event === 'send_refused');
    expect(await refusals()).toEqual([
      expect.objectContaining({
        actor: 'agent',
        detail: expect.objectContaining({
          reason: 'rate_limited',
          from: 'claude-desktop',
          note: expect.stringMatching(/next minute are not recorded/) as string,
        }),
      }),
    ]);
    budd.clock.now += 60_000;
    expect((await send(claude, ['grok-build/researcher'])).isError).toBe(false);
    expect((await send(claude, ['grok-build/researcher'])).text).toMatch(/^rate_limited/);
    expect(await refusals()).toHaveLength(2);
  });
  // Notices are created by the sweeper, not sent, so they never touch the rate limiter.
});

describe('sender outstanding unread deliveries', () => {
  it('counts fan-out per recipient and refuses a send that would exceed the cap', async () => {
    const { claude, grok } = await setup({
      SENDER_MAX_OUTSTANDING: '3',
      SEND_RATE_PER_MIN: '1000',
    });
    await send(claude, ['grok-build/researcher', 'grok-build/writer']); // 2 outstanding
    const over = await send(claude, ['grok-build/researcher', 'claude-code/reviewer']); // would be 4
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/^sender_backlog: .*2 unread deliveries.*limit of 3/);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);

    expect((await send(claude, ['claude-code/reviewer'])).isError).toBe(false); // exactly 3
    expect((await send(claude, ['claude-code/reviewer'])).text).toMatch(/^sender_backlog/);
  });

  it('frees capacity when recipients read, and when deliveries expire', async () => {
    const { claude, grok } = await setup({
      SENDER_MAX_OUTSTANDING: '1',
      SEND_RATE_PER_MIN: '1000',
    });
    await send(claude, ['grok-build/researcher']);
    expect((await send(claude, ['grok-build/writer'])).text).toMatch(/^sender_backlog/);
    await grok.ok('inbox', { handle: 'researcher' });
    expect((await send(claude, ['grok-build/writer'])).isError).toBe(false);

    budd.clock.now += 24 * 3600_000; // writer never reads: its delivery expires
    expect((await send(claude, ['grok-build/researcher'])).isError).toBe(false);
  });

  it('is per connection across all its handles', async () => {
    const { claude } = await setup({ SENDER_MAX_OUTSTANDING: '1', SEND_RATE_PER_MIN: '1000' });
    await send(claude, ['grok-build/researcher'], 'one');
    expect((await send(claude, ['grok-build/researcher'], 'two')).text).toMatch(/^sender_backlog/);
  });
});

describe('recipient unread mailbox', () => {
  it('rejects only the full mailbox, per recipient, until it is read', async () => {
    const { claude, grok, code } = await setup({
      RECIPIENT_MAX_UNREAD: '2',
      SEND_RATE_PER_MIN: '1000',
    });
    await send(claude, ['grok-build/researcher']);
    await send(code, ['grok-build/researcher'], 'reviewer');
    const third = await claude.ok('send', {
      to: ['grok-build/researcher', 'grok-build/writer'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    expect(third.results).toEqual([
      expect.objectContaining({ to: 'grok-build/researcher', reason: 'recipient_backlog' }),
      { to: 'grok-build/writer', status: 'delivered' },
    ]);
    expect(third.results[0].detail).toMatch(/already has 2 unread/);

    await grok.ok('inbox', { handle: 'researcher', limit: 1 });
    expect(
      (await claude.ok('send', { to: ['grok-build/researcher'], from_handle: 'x1', body_md: 'hi' }))
        .results[0].status,
    ).toBe('delivered');
  });
});

describe('other limits are configurable', () => {
  it('inbox max per call', async () => {
    const { grok } = await setup({ INBOX_MAX_LIMIT: '3' });
    expect((await grok.call('inbox', { handle: 'researcher', limit: 4 })).isError).toBe(true);
    expect((await grok.call('inbox', { handle: 'researcher', limit: 3 })).isError).toBe(false);
  });

  it('handles per connection', async () => {
    const { grok } = await setup({ MAX_HANDLES_PER_CONNECTION: '2' }); // researcher, writer
    expect((await grok.call('inbox_count', { handle: 'third' })).text).toMatch(/^handle_limit/);
  });

  it('message size', async () => {
    const { claude } = await setup({ MAX_MESSAGE_BYTES: '10' });
    const ok = await claude.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: '0123456789',
    });
    expect(ok.isError).toBe(false);
    const big = await claude.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: '01234567890',
    });
    expect(big.text).toMatch(/^size: Message is 11 bytes/);
  });

  it('payload depth: 32 levels are fine, 33 and a hostile 6,500 are refused', async () => {
    const { claude } = await setup();
    const nested = (depth: number) => {
      let payload: unknown = 1;
      for (let i = 1; i < depth; i++) payload = [payload];
      return { a: payload };
    };
    const sendPayload = (depth: number) =>
      claude.call('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        payload: nested(depth),
      });
    expect((await sendPayload(32)).isError).toBe(false);
    expect((await sendPayload(33)).text).toMatch(/^invalid_input: payload nests more than 32/);
    // Written out by hand: the MCP client's JSON.stringify can overflow its own stack on this.
    const hostile = `${'['.repeat(6499)}1${']'.repeat(6499)}`;
    const response = await fetch(`${budd.url}/mcp/claude-desktop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send","arguments":{"to":["grok-build/researcher"],"from_handle":"chief-of-staff","payload":{"a":${hostile}}}}}`,
    });
    expect(await response.text()).toMatch(/invalid_input: payload nests/);
  });
});

describe('connections per workspace', () => {
  const firstContact = (name: string) =>
    fetch(`${budd.url}/mcp/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('refuses a new connection over the cap; archived ones don’t count', async () => {
    await setup({ MAX_CONNECTIONS_PER_WORKSPACE: '3' });
    const refused = await firstContact('fourth');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('MAX_CONNECTIONS_PER_WORKSPACE');
    // Existing connections keep working.
    expect((await firstContact('grok-build')).status).toBe(200);

    await budd.admin.archive(budd.adminCtx, 'claude-code');
    expect((await firstContact('fourth')).status).toBe(200);
    await expect(budd.admin.restore(budd.adminCtx, 'claude-code')).rejects.toThrow(
      /the most connections it may have/,
    );
  });
});

describe('workspace storage', () => {
  it('refuses sends once the workspace’s data reaches MAX_WORKSPACE_MB', async () => {
    const { claude, grok } = await setup({
      MAX_WORKSPACE_MB: '1',
      SEND_RATE_PER_MIN: '1000',
      RECIPIENT_MAX_UNREAD: '1000',
      SENDER_MAX_OUTSTANDING: '1000',
    });
    const body = 'x'.repeat(30 * 1024);
    const big = { to: ['grok-build/researcher'], from_handle: 'chief-of-staff', body_md: body };
    let refused: string | undefined;
    let sent = 0;
    while (refused === undefined && sent < 100) {
      const r = await claude.call('send', big);
      if (r.isError) refused = r.text;
      else sent++;
    }
    expect(sent).toBeGreaterThan(10);
    expect(refused).toMatch(/^workspace_full: .*MAX_WORKSPACE_MB/);
    // Reading doesn't need space, and small sends are refused too: the cap is on what's stored.
    expect((await grok.ok('inbox', { handle: 'researcher' })).messages.length).toBeGreaterThan(0);

    // Retention frees the space; the audit rows the sends left don't count.
    budd.clock.now += 30 * 24 * 60 * 60 * 1000;
    await budd.sweep();
    expect((await claude.call('send', big)).isError).toBe(false);
  });
});

describe('audit log size (MAX_AUDIT_MB)', () => {
  /** A human's entry: always written, so it can fill the log however full it is. */
  const pad = (kb: number) =>
    budd.internals.gateway.appendSystemAudit(budd.adminCtx.workspace.id, {
      at: budd.clock.now,
      event: 'policy_widened',
      actor: 'human',
      connectionId: null,
      detail: { pad: 'x'.repeat(kb * 1024) },
    });

  it('refuses agents, changing nothing, once the log is full; humans still act', async () => {
    const { claude, grok } = await setup({ MAX_AUDIT_MB: '1' });
    await send(claude, ['grok-build/researcher']);
    await pad(1024);
    const refused = await send(claude, ['grok-build/researcher']);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^audit_full: .*MAX_AUDIT_MB.*AUDIT_ROTATE=true/);
    const read = await grok.call('inbox', { handle: 'researcher' });
    expect(read.text).toMatch(/^audit_full/);
    // The read was refused whole: the message is still unread.
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
    await budd.admin.block(budd.adminCtx, 'claude-code');
    expect((await budd.audit()).at(-1)?.event).toBe('connection_blocked');
  });

  it('with AUDIT_ROTATE, deletes the oldest entries instead, and says so', async () => {
    const { claude } = await setup({ MAX_AUDIT_MB: '1', AUDIT_ROTATE: 'true' });
    await pad(600);
    await pad(600);
    expect((await send(claude, ['grok-build/researcher'])).isError).toBe(false);
    const log = await budd.audit();
    expect(log.filter((e) => e.event === 'policy_widened')).toHaveLength(1);
    expect(log.find((e) => e.event === 'audit_rotated')).toMatchObject({
      actor: 'system',
      detail: { deleted: expect.any(Number) as number },
    });
  });
});
