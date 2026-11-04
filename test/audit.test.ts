import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

beforeEach(async () => {
  budd = await startTestBudd();
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await grok.ok('inbox_count', { handle: 'researcher' });
  await budd.setPolicy('grok-build', 'all');
});

afterEach(async () => {
  await budd.close();
});

const SECRET_BODY = 'the launch code is swordfish';
const SECRET_PAYLOAD = 'https://private.example.com/doc';

describe('audit log', () => {
  it('records the bus’s events in order, as metadata', async () => {
    const sent = await claude.ok('send', {
      to: ['grok-build/researcher', 'nobody/agent'],
      from_handle: 'chief-of-staff',
      subject: 'plans',
      body_md: SECRET_BODY,
      payload: { link: SECRET_PAYLOAD },
    });
    await grok.ok('inbox', { handle: 'researcher' });

    const log = await budd.audit();
    expect(log.map((e) => e.event)).toEqual([
      'connection_registered', // claude-desktop
      'connection_registered', // grok-build
      'handle_first_seen', // grok-build/researcher, by polling
      'policy_widened', // grok-build -> all, by the human
      'handle_first_seen', // claude-desktop/chief-of-staff, by sending
      'send',
      'inbox_read',
    ]);
    expect(log[2]).toMatchObject({
      actor: 'agent',
      detail: { handle: 'grok-build/researcher', verified: false },
    });
    expect(log[5]).toMatchObject({
      actor: 'agent',
      detail: {
        message_id: sent.message_id,
        thread_id: sent.message_id,
        from: 'claude-desktop/chief-of-staff',
        from_handle_verified: false,
        body_bytes: Buffer.byteLength(SECRET_BODY),
        payload_bytes: JSON.stringify({ link: SECRET_PAYLOAD }).length,
        ttl: '1d',
        delivered: ['grok-build/researcher'],
        rejected: [{ to: 'nobody/agent', reason: 'unknown_connection' }],
      },
    });
    expect(log[6]).toMatchObject({
      actor: 'agent',
      detail: { mailbox: 'grok-build/researcher', message_ids: [sent.message_id] },
    });
  });

  it('keeps the first few rejected recipients and counts the rest by reason', async () => {
    const to = Array.from({ length: 30 }, (_, i) => `nobody-${String(i)}/agent`);
    await claude.ok('send', {
      to: ['grok-build/researcher', ...to],
      from_handle: 'cos',
      body_md: 'x',
    });
    const sent = (await budd.audit()).find((e) => e.event === 'send');
    expect(sent?.detail).toMatchObject({
      delivered: ['grok-build/researcher'],
      rejected: to.slice(0, 5).map((t) => ({ to: t, reason: 'unknown_connection' })),
      rejected_by_reason: { unknown_connection: 30 },
    });
  });

  it('records sends where every recipient was rejected, and whole-send rejections', async () => {
    await claude.ok('send', { to: ['nobody/agent'], from_handle: 'cos', body_md: 'x' });
    await claude.call('send', {
      to: ['grok-build/researcher'],
      from_handle: 'cos',
      body_md: 'x'.repeat(40_000),
    });
    const log = await budd.audit();
    const undelivered = log.filter((e) => e.event === 'send_undelivered');
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]?.detail).toMatchObject({
      message_id: null,
      thread_id: null,
      delivered: [],
      rejected: [{ to: 'nobody/agent', reason: 'unknown_connection' }],
    });
    const rejected = log.filter((e) => e.event === 'send_refused');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.detail).toMatchObject({
      reason: 'size',
      from: 'claude-desktop',
    });
  });

  it('never stores message bodies or payloads', async () => {
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief-of-staff',
      body_md: SECRET_BODY,
      payload: { link: SECRET_PAYLOAD },
    });
    await grok.ok('inbox', { handle: 'researcher' });
    budd.clock.now += 24 * 3600_000;
    await budd.sweep();
    const raw = JSON.stringify(await budd.audit());
    expect(raw).not.toContain('swordfish');
    expect(raw).not.toContain('private.example.com');
  });

  it('is append-only at the database level', () => {
    const ws = budd.adminCtx.workspace.id;
    const db = new Database(path.join(budd.dataDir, 'workspaces', `${ws}.db`));
    try {
      expect(() => db.prepare("UPDATE audit SET event = 'x'").run()).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });
});
