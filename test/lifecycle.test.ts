import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

beforeEach(async () => {
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await budd.setPolicy('grok-build', 'all');
  await budd.setPolicy('claude-desktop', 'all');
});

afterEach(async () => {
  await budd.close();
});

const hi = (to: string, from_handle = 'chief-of-staff') => ({
  to: [to],
  from_handle,
  body_md: 'hi',
});

/** A raw MCP initialize request, as an AI app reconnecting would send. */
const initialize = (connection: string) =>
  fetch(`${budd.url}/mcp/${connection}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });

describe('blocking a connection', () => {
  beforeEach(async () => {
    expect(await budd.admin.block(budd.adminCtx, 'grok-build')).toBe(true);
  });

  it('makes every tool call from it fail', async () => {
    for (const tool of ['whoami', 'list_connections', 'policy_get']) {
      await expect(grok.call(tool), tool).rejects.toThrow(/blocked/);
    }
    await expect(
      grok.call('send', hi('claude-desktop/chief-of-staff', 'researcher')),
    ).rejects.toThrow(/blocked/);
    await expect(grok.call('inbox', { handle: 'researcher' })).rejects.toThrow(/blocked/);
  });

  it('can’t re-register in local mode: the same URL stays refused', async () => {
    const res = await initialize('grok-build');
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/blocked.*Budd UI/);
    await expect(budd.connect('grok-build')).rejects.toThrow();
  });

  it('rejects sends addressed to it as blocked', async () => {
    const sent = await claude.ok('send', hi('grok-build/researcher'));
    expect(sent.results[0]).toMatchObject({ status: 'rejected', reason: 'blocked' });
  });

  it('shows it as blocked and not accepting messages', async () => {
    const list = await claude.ok('list_connections');
    expect(list.connections.find((c: any) => c.connection === 'grok-build')).toMatchObject({
      status: 'blocked',
      accepts_messages_from_you: false,
    });
  });

  it('lets its existing unread deliveries expire normally, with a notice to the sender', async () => {
    await budd.admin.unblock(budd.adminCtx, 'grok-build', { confirmed: true });
    await claude.ok('send', hi('grok-build/researcher'));
    await budd.admin.block(budd.adminCtx, 'grok-build');
    budd.clock.now += 24 * 3600_000;
    await budd.sweep();
    const notices = (await claude.ok('inbox', { handle: 'chief-of-staff' })).messages;
    expect(notices.map((n: any) => [n.type, n.payload.recipient])).toEqual([
      ['notice', 'grok-build/researcher'],
    ]);
  });

  it('is idempotent and audited as done by a human', async () => {
    expect(await budd.admin.block(budd.adminCtx, 'grok-build')).toBe(false);
    const blocked = (await budd.audit()).filter((e) => e.event === 'connection_blocked');
    expect(blocked).toEqual([
      expect.objectContaining({ actor: 'human', detail: { connection: 'grok-build' } }),
    ]);
  });
});

describe('unblocking', () => {
  it('restores tool calls, delivery and the previous policy', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    await budd.admin.block(budd.adminCtx, 'grok-build');
    expect(await budd.admin.unblock(budd.adminCtx, 'grok-build', { confirmed: true })).toBe(true);

    expect((await initialize('grok-build')).status).toBe(200);
    expect((await grok.ok('whoami')).connection).toBe('grok-build');
    expect(await grok.ok('policy_get')).toMatchObject({
      mode: 'allowlist',
      allowed_connections: ['claude-desktop'],
    });
    const sent = await claude.ok('send', hi('grok-build/researcher'));
    expect(sent.results[0].status).toBe('delivered');
    expect((await budd.audit()).map((e) => e.event)).toContain('connection_unblocked');
  });
});

describe('relabelling', () => {
  it('sets a display label without changing the slug, and audits it', async () => {
    await budd.admin.relabel(budd.adminCtx, 'grok-build', '  Grok on my laptop ');
    const list = await claude.ok('list_connections');
    expect(list.connections.find((c: any) => c.connection === 'grok-build').label).toBe(
      'Grok on my laptop',
    );
    await budd.admin.relabel(budd.adminCtx, 'grok-build', '');
    const relabels = (await budd.audit()).filter((e) => e.event === 'connection_relabelled');
    expect(relabels.map((e) => e.detail)).toEqual([
      { connection: 'grok-build', from: null, to: 'Grok on my laptop' },
      { connection: 'grok-build', from: 'Grok on my laptop', to: null },
    ]);
  });
});

describe('admin errors', () => {
  it('refuses unknown connections and the system connection', async () => {
    await expect(budd.admin.block(budd.adminCtx, 'nobody')).rejects.toMatchObject({
      code: 'unknown_connection',
    });
    await expect(budd.admin.block(budd.adminCtx, 'budd')).rejects.toMatchObject({
      code: 'unknown_connection',
    });
  });
});
