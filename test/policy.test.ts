import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminError } from '../src/admin/Admin.js';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;
let code: Agent;

beforeEach(async () => {
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  code = await budd.connect('claude-code');
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await code.ok('inbox_count', { handle: 'reviewer' });
});

afterEach(async () => {
  await budd.close();
});

const msg = (to: string, from_handle = 'chief-of-staff') => ({
  to: [to],
  from_handle,
  body_md: 'hi',
});

describe('default policy', () => {
  it('new connections accept no other connection, and the rejection says a human must use the UI', async () => {
    const sent = await claude.ok('send', msg('grok-build/researcher'));
    expect(sent.message_id).toBeNull();
    expect(sent.results[0]).toMatchObject({ status: 'rejected', reason: 'policy' });
    expect(sent.results[0].detail).toMatch(/human has to update .*Budd UI/);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);

    expect(await grok.ok('policy_get')).toMatchObject({
      connection: 'grok-build',
      mode: 'allowlist',
      allowed_connections: [],
    });
  });

  it('always allows handles of the same connection', async () => {
    await grok.ok('inbox_count', { handle: 'writer' });
    const sent = await grok.ok('send', msg('grok-build/writer', 'researcher'));
    expect(sent.results[0].status).toBe('delivered');
  });

  it('reports per recipient: allowed recipients get the message, others are refused', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    const sent = await claude.ok('send', {
      to: ['grok-build/researcher', 'claude-code/reviewer'],
      from_handle: 'chief-of-staff',
      body_md: 'hi',
    });
    expect(sent.results.map((r: any) => [r.to, r.status, r.reason])).toEqual([
      ['grok-build/researcher', 'delivered', undefined],
      ['claude-code/reviewer', 'rejected', 'policy'],
    ]);
  });

  it('list_connections shows who accepts messages from the caller', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    await budd.setPolicy('claude-code', 'all');
    const list = await claude.ok('list_connections');
    const accepts = Object.fromEntries(
      list.connections.map((c: any) => [c.connection, c.accepts_messages_from_you]),
    );
    expect(accepts).toEqual({ 'claude-code': true, 'claude-desktop': true, 'grok-build': true });
    const fromGrok = await grok.ok('list_connections');
    expect(
      fromGrok.connections.find((c: any) => c.connection === 'claude-desktop')
        .accepts_messages_from_you,
    ).toBe(false);
    expect(list.policy_note).toMatch(/Only a human can widen/);
  });
});

describe('tightening through MCP', () => {
  it('removes connections from the allowlist, effective immediately', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop', 'claude-code']);
    const r = await grok.ok('policy_tighten', { remove_connections: ['claude-desktop', 'nobody'] });
    expect(r).toMatchObject({
      changed: true,
      removed: ['claude-desktop'],
      not_in_allowlist: ['nobody'],
      policy: { mode: 'allowlist', allowed_connections: ['claude-code'] },
    });
    const sent = await claude.ok('send', msg('grok-build/researcher'));
    expect(sent.results[0].reason).toBe('policy');
    const ok = await code.ok('send', msg('grok-build/researcher', 'reviewer'));
    expect(ok.results[0].status).toBe('delivered');
  });

  it('switches from "all" to "allowlist"', async () => {
    await budd.setPolicy('grok-build', 'all', ['claude-code']);
    const r = await grok.ok('policy_tighten', { mode: 'allowlist' });
    expect(r.policy).toMatchObject({ mode: 'allowlist', allowed_connections: ['claude-code'] });
    expect((await claude.ok('send', msg('grok-build/researcher'))).results[0].reason).toBe(
      'policy',
    );
  });

  it('is audited as tightened by an agent', async () => {
    await budd.setPolicy('grok-build', 'all');
    await grok.ok('policy_tighten', { mode: 'allowlist' });
    const event = (await budd.audit()).filter((e) => e.event === 'policy_tightened').at(-1);
    expect(event).toMatchObject({
      actor: 'agent',
      detail: {
        connection: 'grok-build',
        via: 'mcp',
        before: { mode: 'all', allowed_connections: [] },
        after: { mode: 'allowlist', allowed_connections: [] },
      },
    });
  });

  it('a no-op tighten changes nothing and is not audited', async () => {
    const before = (await budd.audit()).length;
    const r = await grok.ok('policy_tighten', { remove_connections: ['claude-desktop'] });
    expect(r.changed).toBe(false);
    expect((await budd.audit()).length).toBe(before);
  });
});

describe('the ratchet: no widening through MCP', () => {
  const widenAttempts: Record<string, unknown>[] = [
    { mode: 'all' },
    { mode: 'ALL' },
    { mode: 'open' },
    { mode: 'allowlist', add_connections: ['claude-desktop'] },
    { allowed_connections: ['claude-desktop'] },
    { remove_connections: [], add: ['claude-desktop'] },
    { remove_connections: ['claude-code'], allow: 'claude-desktop', mode: 'all' },
    { connection: 'grok-build', mode: 'all' },
    {},
  ];

  it.each(widenAttempts)('policy_tighten(%j) cannot widen', async (args) => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-code']);
    await grok.call('policy_tighten', args);
    expect(await grok.ok('policy_get')).toMatchObject({
      mode: 'allowlist',
      allowed_connections: expect.not.arrayContaining(['claude-desktop']),
    });
    expect((await claude.ok('send', msg('grok-build/researcher'))).results[0].reason).toBe(
      'policy',
    );
  });

  it('refuses mode "all" with an explanation', async () => {
    const r = await grok.call('policy_tighten', { mode: 'all' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^cannot_widen: .*Only a human can widen/);
  });

  it('offers no tool that could widen a policy', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'list', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${budd.url}/mcp/lister`)));
    const { tools } = await client.listTools();
    const policyTools = tools.filter((t) => t.name.startsWith('policy'));
    expect(policyTools.map((t) => t.name).sort()).toEqual(['policy_get', 'policy_tighten']);
    const tighten = policyTools.find((t) => t.name === 'policy_tighten');
    expect(Object.keys(tighten?.inputSchema.properties ?? {}).sort()).toEqual([
      'mode',
      'remove_connections',
    ]);
    await client.close();
  });
});

describe('policy isolation between connections', () => {
  it('policy_get only ever shows the caller’s own policy', async () => {
    await budd.setPolicy('grok-build', 'all');
    const r = await claude.ok('policy_get', { connection: 'grok-build' });
    expect(r).toMatchObject({ connection: 'claude-desktop', mode: 'allowlist' });
  });

  it('policy_tighten only ever changes the caller’s own policy', async () => {
    await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
    await budd.setPolicy('claude-desktop', 'allowlist', ['claude-code']);
    await claude.ok('policy_tighten', {
      connection: 'grok-build',
      remove_connections: ['claude-desktop', 'claude-code'],
    });
    expect((await grok.ok('policy_get')).allowed_connections).toEqual(['claude-desktop']);
    expect((await claude.ok('policy_get')).allowed_connections).toEqual([]);
  });
});

describe('human policy changes (admin service behind the UI)', () => {
  it('refuses to widen without confirmation, and changes nothing', async () => {
    await expect(
      budd.admin.setPolicy(budd.adminCtx, 'grok-build', { mode: 'all', allowed: [] }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    await expect(
      budd.admin.setPolicy(budd.adminCtx, 'grok-build', {
        mode: 'allowlist',
        allowed: ['claude-desktop'],
      }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(await grok.ok('policy_get')).toMatchObject({
      mode: 'allowlist',
      allowed_connections: [],
    });
  });

  it('tightens without confirmation', async () => {
    await budd.setPolicy('grok-build', 'all');
    const r = await budd.admin.setPolicy(budd.adminCtx, 'grok-build', {
      mode: 'allowlist',
      allowed: [],
    });
    expect(r).toEqual({ widened: false, changed: true });
  });

  it('widens with confirmation and audits it as widened by a human', async () => {
    const r = await budd.admin.setPolicy(
      budd.adminCtx,
      'grok-build',
      { mode: 'allowlist', allowed: ['claude-desktop'] },
      { confirmed: true },
    );
    expect(r).toEqual({ widened: true, changed: true });
    const event = (await budd.audit()).filter((e) => e.event === 'policy_widened').at(-1);
    expect(event).toMatchObject({
      actor: 'human',
      detail: {
        confirmed: true,
        before: { mode: 'allowlist', allowed_connections: [] },
        after: { mode: 'allowlist', allowed_connections: ['claude-desktop'] },
      },
    });
    expect((await claude.ok('send', msg('grok-build/researcher'))).results[0].status).toBe(
      'delivered',
    );
  });

  it('rejects unknown connections and the system connection', async () => {
    for (const allowed of [['nobody'], ['budd']]) {
      await expect(
        budd.admin.setPolicy(
          budd.adminCtx,
          'grok-build',
          { mode: 'allowlist', allowed },
          { confirmed: true },
        ),
      ).rejects.toMatchObject({ code: 'unknown_connection' });
    }
  });
});
