import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRUST_NOTICE } from '../src/bus/trust.js';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;
let code: Agent;

beforeEach(async () => {
  // Limits and policies have their own tests (limits.test.ts, policy.test.ts).
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  code = await budd.connect('claude-code');
  for (const c of ['claude-desktop', 'grok-build', 'claude-code']) await budd.setPolicy(c, 'all');
  // Polling claims handles, so these agents are addressable from the start.
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await grok.ok('inbox_count', { handle: 'writer' });
  await code.ok('inbox_count', { handle: 'reviewer' });
});

afterEach(async () => {
  await budd.close();
});

const hello = (to: string[], extra: Record<string, unknown> = {}) => ({
  to,
  from_handle: 'chief-of-staff',
  subject: 'hello',
  body_md: 'Hi there',
  ...extra,
});

describe('send and consume-on-read', () => {
  it('delivers a message that the recipient reads exactly once, as an envelope', async () => {
    const sent = await claude.ok(
      'send',
      hello(['grok-build/researcher'], { payload: { url: 'https://example.com' } }),
    );
    expect(sent.results).toEqual([{ to: 'grok-build/researcher', status: 'delivered' }]);
    expect(sent.thread_id).toBe(sent.message_id);

    expect(await grok.ok('inbox_count', { handle: 'researcher' })).toEqual({
      mailbox: 'grok-build/researcher',
      unread: 1,
    });

    const inbox = await grok.ok('inbox', { handle: 'researcher' });
    expect(inbox.mailbox).toBe('grok-build/researcher');
    expect(inbox.remaining).toBe(0);
    expect(inbox.messages).toEqual([
      {
        id: sent.message_id,
        type: 'message',
        from: {
          workspace: 'local',
          connection: 'claude-desktop',
          connection_verified: true,
          handle: 'chief-of-staff',
          handle_verified: false,
        },
        trust_notice: TRUST_NOTICE,
        subject: 'hello',
        body_md: 'Hi there',
        payload: { url: 'https://example.com' },
        thread_id: sent.message_id,
        reply_to: null,
        created_at: '2026-10-15T12:00:00.000Z',
        expires_at: '2026-10-16T12:00:00.000Z',
      },
    ]);

    // Consumed: never returned again.
    expect((await grok.ok('inbox', { handle: 'researcher' })).messages).toEqual([]);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
  });

  it('keeps each handle’s mailbox separate', async () => {
    await claude.ok('send', hello(['grok-build/researcher']));
    expect((await grok.ok('inbox_count', { handle: 'writer' })).unread).toBe(0);
    expect((await grok.ok('inbox', { handle: 'writer' })).messages).toEqual([]);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
  });

  it('fans out: one delivery per recipient, each consumed independently', async () => {
    const sent = await claude.ok(
      'send',
      hello(['grok-build/researcher', 'grok-build/writer', 'claude-code/reviewer']),
    );
    expect(sent.results.map((r: any) => r.status)).toEqual(['delivered', 'delivered', 'delivered']);

    const r1 = await grok.ok('inbox', { handle: 'researcher' });
    const r2 = await grok.ok('inbox', { handle: 'writer' });
    const r3 = await code.ok('inbox', { handle: 'reviewer' });
    for (const r of [r1, r2, r3])
      expect(r.messages.map((m: any) => m.id)).toEqual([sent.message_id]);
  });

  it('collapses duplicate recipients into one delivery', async () => {
    const sent = await claude.ok(
      'send',
      hello(['grok-build/researcher', 'Grok-Build/Researcher', 'local/grok-build/researcher']),
    );
    expect(sent.results).toEqual([{ to: 'grok-build/researcher', status: 'delivered' }]);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
  });

  it('returns oldest first, honours limit, and reports remaining', async () => {
    for (let i = 0; i < 3; i++) {
      await claude.ok('send', hello(['grok-build/researcher'], { subject: `m${i}` }));
      budd.clock.now += 1000;
    }
    const first = await grok.ok('inbox', { handle: 'researcher', limit: 2 });
    expect(first.messages.map((m: any) => m.subject)).toEqual(['m0', 'm1']);
    expect(first.remaining).toBe(1);
    const rest = await grok.ok('inbox', { handle: 'researcher' });
    expect(rest.messages.map((m: any) => m.subject)).toEqual(['m2']);
  });

  it('caps inbox limit at 50', async () => {
    const r = await grok.call('inbox', { handle: 'researcher', limit: 51 });
    expect(r.isError).toBe(true);
  });

  it('does not return deliveries past their expiry time', async () => {
    await claude.ok('send', hello(['grok-build/researcher']));
    budd.clock.now += 24 * 3600_000; // exactly the 1-day delivery TTL
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
    expect((await grok.ok('inbox', { handle: 'researcher' })).messages).toEqual([]);
  });

  it('lets a connection message its own handles', async () => {
    const sent = await grok.ok('send', {
      to: ['grok-build/writer'],
      from_handle: 'researcher',
      body_md: 'note to self',
    });
    expect(sent.results[0].status).toBe('delivered');
    const inbox = await grok.ok('inbox', { handle: 'writer' });
    expect(inbox.messages[0].from).toMatchObject({
      connection: 'grok-build',
      handle: 'researcher',
    });
  });
});

describe('content validation', () => {
  it('requires body_md or payload', async () => {
    const r = await claude.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
    });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/needs body_md, payload, or both/);
  });

  it('accepts exactly 32 KB of body_md + payload and rejects one byte more', async () => {
    const payload = { k: 'v' }; // serialises to 9 bytes
    const fits = 'x'.repeat(32 * 1024 - 9);
    const ok = await claude.call(
      'send',
      hello(['grok-build/researcher'], { body_md: fits, payload }),
    );
    expect(ok.isError).toBe(false);

    const tooBig = await claude.call(
      'send',
      hello(['grok-build/researcher'], { body_md: fits + 'x', payload }),
    );
    expect(tooBig.isError).toBe(true);
    expect(tooBig.text).toMatch(/^size: Message is 32769 bytes/);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const r = await claude.call(
      'send',
      hello(['grok-build/researcher'], { body_md: '€'.repeat(11_000) }),
    ); // 33,000 bytes
    expect(r.text).toMatch(/^size:/);
  });

  it('rejects an over-long subject', async () => {
    const r = await claude.call(
      'send',
      hello(['grok-build/researcher'], { subject: 's'.repeat(201) }),
    );
    expect(r.isError).toBe(true);
  });

  it('requires a payload to be a JSON object', async () => {
    const r = await claude.call('send', hello(['grok-build/researcher'], { payload: [1, 2] }));
    expect(r.isError).toBe(true);
  });
});

describe('handles', () => {
  it('requires from_handle on send and handle on inbox / inbox_count', async () => {
    const send = await claude.call('send', { to: ['grok-build/researcher'], body_md: 'x' });
    expect(send.isError).toBe(true);
    expect(send.text).toMatch(/from_handle/);
    for (const tool of ['inbox', 'inbox_count']) {
      const r = await grok.call(tool, {});
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/handle/);
    }
    const empty = await grok.call('inbox', { handle: '  ' });
    expect(empty.isError).toBe(true);
  });

  it('registers a handle on first send and on first poll', async () => {
    await code.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'architect',
      body_md: 'x',
    });
    await code.ok('inbox_count', { handle: 'tester' });
    const me = await code.ok('whoami');
    expect(me.handles_seen.sort()).toEqual(['architect', 'reviewer', 'tester']);
    const list = await claude.ok('list_connections');
    const entry = list.connections.find((c: any) => c.connection === 'claude-code');
    expect(entry.handles.sort()).toEqual(['architect', 'reviewer', 'tester']);
    expect(list.handles_note).toMatch(/unverified/);
  });

  it('normalises handles to lowercase', async () => {
    await claude.ok('send', hello(['grok-build/researcher'], { from_handle: 'Chief-Of-Staff' }));
    const m = (await grok.ok('inbox', { handle: 'RESEARCHER' })).messages[0];
    expect(m.from.handle).toBe('chief-of-staff');
  });

  it('caps handles per connection (default 25) on send, poll and claim', async () => {
    // claude-desktop already has chief-of-staff.
    for (let i = 1; i < 25; i++) await claude.ok('inbox_count', { handle: `h${i}` });
    const poll = await claude.call('inbox_count', { handle: 'one-too-many' });
    expect(poll.text).toMatch(/^handle_limit:.*maximum of 25 handles/);
    const send = await claude.call(
      'send',
      hello(['grok-build/researcher'], { from_handle: 'another' }),
    );
    expect(send.text).toMatch(/^handle_limit:/);
    expect((await claude.call('claim_handle', { handle: 'one-more' })).text).toMatch(
      /^handle_limit:/,
    );
    expect((await claude.ok('claim_handle', { handle: 'h1' })).claimed).toBe('already_yours');
    // Nothing was stored for the refused send.
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
    // Existing handles keep working.
    await claude.ok('send', hello(['grok-build/researcher'], { from_handle: 'h3' }));
  });
});

describe('addressing rules', () => {
  it('rejects unknown connections per recipient while delivering to the rest', async () => {
    const sent = await claude.ok('send', hello(['grok-build/researcher', 'nobody/agent']));
    expect(sent.results).toEqual([
      { to: 'grok-build/researcher', status: 'delivered' },
      expect.objectContaining({
        to: 'nobody/agent',
        status: 'rejected',
        reason: 'unknown_connection',
      }),
    ]);
  });

  it('rejects unknown handles (a handle must have been seen)', async () => {
    const sent = await claude.ok('send', hello(['grok-build/stranger']));
    expect(sent.message_id).toBeNull();
    expect(sent.results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: 'unknown_handle' }),
    ]);
    expect(sent.results[0].detail).toMatch(/list_connections/);
  });

  it('accepts a fully qualified address in the sender’s own workspace', async () => {
    const sent = await claude.ok('send', hello(['local/grok-build/researcher']));
    expect(sent.results).toEqual([{ to: 'grok-build/researcher', status: 'delivered' }]);
  });

  it('rejects other workspaces as cross_workspace without revealing whether they exist', async () => {
    const sent = await claude.ok(
      'send',
      hello(['alice/grok-build/researcher', 'local/grok-build/researcher']),
    );
    expect(sent.results[0]).toMatchObject({
      to: 'alice/grok-build/researcher',
      status: 'rejected',
      reason: 'cross_workspace',
    });
    expect(sent.results[1]).toMatchObject({ status: 'delivered' });
  });

  it('fails the whole send for "@" or a bare connection', async () => {
    const at = await claude.call('send', hello(['grok-build/researcher', 'researcher@grok-build']));
    expect(at.text).toMatch(/^invalid_address:.*reserved for future federation/);
    const bare = await claude.call('send', hello(['grok-build']));
    expect(bare.text).toMatch(/^invalid_address:.*missing a handle/);
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
  });

  it('stores nothing when every recipient is rejected', async () => {
    const sent = await claude.ok('send', hello(['nobody/agent']));
    expect(sent).toMatchObject({ message_id: null, thread_id: null });
  });
});

describe('threads and replies', () => {
  it('threads replies and shows only messages the connection sent or has read', async () => {
    const first = await claude.ok('send', hello(['grok-build/researcher']));
    await grok.ok('inbox', { handle: 'researcher' });
    budd.clock.now += 1000;
    const reply = await grok.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'On it',
      reply_to: first.message_id,
    });
    expect(reply.thread_id).toBe(first.message_id);

    // Claude has not read the reply yet: thread shows only what it sent (ADR 0004).
    let thread = await claude.ok('thread', { thread_id: first.message_id });
    expect(thread.messages.map((m: any) => m.id)).toEqual([first.message_id]);
    // Thread does not consume.
    expect((await claude.ok('inbox_count', { handle: 'chief-of-staff' })).unread).toBe(1);

    const inbox = await claude.ok('inbox', { handle: 'chief-of-staff' });
    expect(inbox.messages[0]).toMatchObject({
      reply_to: first.message_id,
      thread_id: first.message_id,
    });
    thread = await claude.ok('thread', { thread_id: first.message_id });
    expect(thread.messages.map((m: any) => m.id)).toEqual([first.message_id, reply.message_id]);

    // A connection outside the thread sees nothing.
    expect((await code.ok('thread', { thread_id: first.message_id })).messages).toEqual([]);
  });

  it('rejects reply_to for a message the sender never saw', async () => {
    const private1 = await claude.ok('send', hello(['grok-build/researcher']));
    const r = await code.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'reviewer',
      body_md: 'x',
      reply_to: private1.message_id,
    });
    expect(r.text).toMatch(/^unknown_reply_to:/);
  });

  it('posts into a thread only if the sender’s connection has a message in it', async () => {
    const first = await claude.ok('send', hello(['grok-build/researcher']));
    const outsider = await code.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'reviewer',
      body_md: 'x',
      thread_id: first.message_id,
    });
    expect(outsider.text).toMatch(/^unknown_thread:/);
    // A recipient may, before or after reading it, and so may the sender.
    const recipient = await grok.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'x',
      thread_id: first.message_id,
    });
    expect(recipient.thread_id).toBe(first.message_id);
    const sender = await claude.ok(
      'send',
      hello(['grok-build/researcher'], { thread_id: first.message_id }),
    );
    expect(sender.thread_id).toBe(first.message_id);
  });

  it('validates thread_id format', async () => {
    const r = await claude.call(
      'send',
      hello(['grok-build/researcher'], { thread_id: 'not-a-ulid' }),
    );
    expect(r.text).toMatch(/^invalid_input: thread_id/);
    const t = await claude.call('thread', { thread_id: 'nope' });
    expect(t.isError).toBe(true);
  });
});

describe('whoami and list_connections', () => {
  it('reports identity, mode, protocol version and the trust model', async () => {
    const me = await claude.ok('whoami');
    expect(me).toMatchObject({
      workspace: 'local',
      connection: 'claude-desktop',
      connection_verified: true,
      mode: 'local',
      protocol_version: '1',
      handles_seen: ['chief-of-staff'],
    });
    expect(me.trust).toMatch(/does not verify handles/);
    expect(me.polling).toMatch(/inbox_count/);
  });

  it('tells a new connection it has no handle yet, and to ask its human', async () => {
    const fresh = await budd.connect('claude-chat');
    const me = await fresh.ok('whoami');
    expect(me.handles_seen).toEqual([]);
    expect(me.your_handle).toMatch(/no handles yet/);
    expect(me.your_handle).toMatch(/ask your human/);
    expect(me.your_handle).toMatch(/claim_handle/);
    expect((await claude.ok('whoami')).your_handle).toMatch(/one of handles_seen/);
  });

  it('claim_handle makes a handle addressable before the agent sends or polls', async () => {
    const fresh = await budd.connect('claude-chat');
    expect(await fresh.ok('claim_handle', { handle: 'Planner' })).toMatchObject({
      mailbox: 'claude-chat/planner',
      claimed: 'new',
    });
    expect((await fresh.ok('claim_handle', { handle: 'planner' })).claimed).toBe('already_yours');
    expect((await fresh.ok('whoami')).handles_seen).toEqual(['planner']);
    const listed = (await claude.ok('list_connections')).connections.find(
      (c: any) => c.connection === 'claude-chat',
    );
    expect(listed.handles).toEqual(['planner']);
  });

  it('claim_handle refuses an invalid or missing handle', async () => {
    const fresh = await budd.connect('claude-chat');
    expect((await fresh.call('claim_handle', { handle: 'no spaces' })).text).toMatch(/invalid/);
    expect((await fresh.call('claim_handle', {})).isError).toBe(true);
  });

  it('lists connections with whether each accepts messages from the caller', async () => {
    const list = await claude.ok('list_connections');
    expect(list.connections.map((c: any) => c.connection)).toEqual([
      'claude-code',
      'claude-desktop',
      'grok-build',
    ]);
    const self = list.connections.find((c: any) => c.connection === 'claude-desktop');
    expect(self).toMatchObject({ you: true, accepts_messages_from_you: true, status: 'active' });
  });

  it('exposes exactly the nine tools, with handle warnings in their descriptions', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'list', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${budd.url}/mcp/lister`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'claim_handle',
        'inbox',
        'inbox_count',
        'list_connections',
        'policy_get',
        'policy_tighten',
        'send',
        'thread',
        'whoami',
      ].sort(),
    );
    for (const name of ['send', 'list_connections', 'inbox', 'inbox_count', 'claim_handle']) {
      const tool = tools.find((t) => t.name === name);
      expect(JSON.stringify(tool), name).toMatch(/unverified/);
    }
    expect(tools.find((t) => t.name === 'inbox')?.description).toMatch(/NOT access control/);
    await client.close();
  });
});
