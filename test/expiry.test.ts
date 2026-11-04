import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRUST_NOTICE } from '../src/bus/trust.js';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

beforeEach(async () => {
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await claude.ok('inbox_count', { handle: 'chief-of-staff' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await grok.ok('inbox_count', { handle: 'writer' });
  // Only grok-build accepts claude-desktop. claude-desktop keeps the default
  // (deny everyone), which notices must ignore.
  await budd.setPolicy('grok-build', 'allowlist', ['claude-desktop']);
});

afterEach(async () => {
  await budd.close();
});

const send = (extra: Record<string, unknown> = {}) =>
  claude.ok('send', {
    to: ['grok-build/researcher'],
    from_handle: 'chief-of-staff',
    subject: 'otters',
    body_md: 'three facts please',
    ...extra,
  });

const events = async (name: string) => (await budd.audit()).filter((e) => e.event === name);

describe('delivery expiry and notices', () => {
  it('expires an unread delivery and sends one notice to the original sender’s handle', async () => {
    const sent = await send();
    budd.clock.now += DAY;
    await budd.sweep();

    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
    const inbox = await claude.ok('inbox', { handle: 'chief-of-staff' });
    expect(inbox.messages).toHaveLength(1);
    const notice = inbox.messages[0];
    expect(notice).toMatchObject({
      type: 'notice',
      from: {
        workspace: 'local',
        connection: 'budd',
        connection_verified: true,
        handle: null,
        handle_verified: false,
      },
      trust_notice: TRUST_NOTICE,
      subject: 'Not delivered',
      thread_id: sent.message_id,
      reply_to: sent.message_id,
      payload: {
        notice: 'delivery_expired',
        message_id: sent.message_id,
        recipient: 'grok-build/researcher',
        expired_at: '2026-10-16T12:00:00.000Z',
      },
    });
    expect(notice.body_md).toContain('grok-build/researcher');
    // The notice speaks as Budd, so it never quotes the sender's words.
    expect(JSON.stringify(notice)).not.toContain('otters');

    // Sweeping again creates nothing new.
    await budd.sweep();
    expect((await claude.ok('inbox_count', { handle: 'chief-of-staff' })).unread).toBe(0);
    expect(await events('notice_created')).toHaveLength(1);
  });

  it('sends one notice per expired recipient and none for deliveries that were read', async () => {
    await claude.ok('send', {
      to: ['grok-build/researcher', 'grok-build/writer'],
      from_handle: 'chief-of-staff',
      body_md: 'x',
    });
    await grok.ok('inbox', { handle: 'writer' });
    budd.clock.now += DAY;
    await budd.sweep();
    const notices = (await claude.ok('inbox', { handle: 'chief-of-staff' })).messages;
    expect(notices.map((n: any) => n.payload.recipient)).toEqual(['grok-build/researcher']);
  });

  it('does not expire a delivery before its time', async () => {
    await send();
    budd.clock.now += DAY - 1;
    await budd.sweep();
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
    expect(await events('delivery_expired')).toEqual([]);
  });

  it('notices are leaf nodes: an expired notice never creates another notice', async () => {
    await send();
    budd.clock.now += DAY;
    await budd.sweep(); // message expires -> notice to claude-desktop/chief-of-staff
    expect(await events('notice_created')).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      budd.clock.now += DAY;
      await budd.sweep(); // the unread notice expires; nothing new is created
    }
    const expired = await events('delivery_expired');
    expect(expired.map((e) => e.detail.type)).toEqual(['message', 'notice']);
    expect(await events('notice_created')).toHaveLength(1);
    expect((await claude.ok('inbox_count', { handle: 'chief-of-staff' })).unread).toBe(0);
  });

  it('notices ignore the sender’s policy and full mailbox', async () => {
    await budd.close();
    budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000', RECIPIENT_MAX_UNREAD: '1' });
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
    await grok.ok('inbox_count', { handle: 'researcher' });
    await budd.setPolicy('grok-build', 'all');
    // Fill claude-desktop/chief-of-staff (a same-connection message, kept for 7 days).
    await claude.ok('inbox_count', { handle: 'chief-of-staff' });
    await claude.ok('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'scheduler',
      body_md: 'reminder',
      ttl: '7d',
    });
    await send({ ttl: '1h' });
    budd.clock.now += HOUR;
    await budd.sweep();
    expect((await claude.ok('inbox_count', { handle: 'chief-of-staff' })).unread).toBe(2);
  });

  it('the system connection is hidden and can’t be messaged', async () => {
    await send();
    budd.clock.now += DAY;
    await budd.sweep();
    const list = await claude.ok('list_connections');
    expect(list.connections.map((c: any) => c.connection)).not.toContain('budd');
    const r = await claude.ok('send', {
      to: ['budd/notices'],
      from_handle: 'chief-of-staff',
      body_md: 'thanks',
    });
    expect(r.results[0]).toMatchObject({ reason: 'unknown_connection' });
    expect(r.results[0].detail).toMatch(/sends notices/);
  });
});

describe('the sweeper timer', () => {
  it('runs the expiry job on SWEEP_INTERVAL without being called', async () => {
    await budd.close();
    budd = await startTestBudd({ SWEEP_INTERVAL: '20ms' });
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
    await grok.ok('inbox_count', { handle: 'researcher' });
    await budd.setPolicy('grok-build', 'all');
    await send();
    budd.clock.now += DAY;
    await expect
      .poll(async () => (await events('delivery_expired')).length, { timeout: 2000 })
      .toBe(1);
  });
});

describe('per-message ttl', () => {
  it('sets expires_at from ttl and expires on time', async () => {
    const sent = await send({ ttl: '3d' });
    expect(sent.expires_at).toBe('2026-10-18T12:00:00.000Z');
    budd.clock.now += 2 * DAY;
    await budd.sweep();
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(1);
    budd.clock.now += DAY;
    await budd.sweep();
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
  });

  it('defaults to DELIVERY_TTL', async () => {
    expect((await send()).expires_at).toBe('2026-10-16T12:00:00.000Z');
  });

  it('accepts up to MAX_DELIVERY_TTL (7d) and rejects anything longer', async () => {
    expect((await send({ ttl: '7d' })).expires_at).toBe('2026-10-22T12:00:00.000Z');
    expect((await send({ ttl: '168h' })).expires_at).toBe('2026-10-22T12:00:00.000Z');
    for (const ttl of ['8d', '169h', '1y']) {
      const r = await claude.call('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        body_md: 'x',
        ttl,
      });
      expect(r.text, ttl).toMatch(/^invalid_input: ttl must be .*at most 7d/);
    }
  });

  it('rejects malformed or zero ttl values', async () => {
    for (const ttl of ['0s', 'soon', '1 day', '-1d', '']) {
      const r = await claude.call('send', {
        to: ['grok-build/researcher'],
        from_handle: 'chief-of-staff',
        body_md: 'x',
        ttl,
      });
      expect(r.isError, ttl).toBe(true);
    }
    expect((await grok.ok('inbox_count', { handle: 'researcher' })).unread).toBe(0);
  });

  it('respects a configured MAX_DELIVERY_TTL', async () => {
    await budd.close();
    budd = await startTestBudd({ DELIVERY_TTL: '1h', MAX_DELIVERY_TTL: '2h' });
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
    await grok.ok('inbox_count', { handle: 'researcher' });
    await budd.setPolicy('grok-build', 'all');
    expect(
      (
        await claude.call('send', {
          to: ['grok-build/researcher'],
          from_handle: 'cos',
          body_md: 'x',
          ttl: '3h',
        })
      ).text,
    ).toMatch(/at most 2h/);
  });
});

describe('retention vs audit', () => {
  it('purges messages after RETENTION_TTL but keeps their audit rows', async () => {
    const sent = await send();
    await grok.ok('inbox', { handle: 'researcher' });
    budd.clock.now += 30 * DAY - 1;
    await budd.sweep();
    expect((await grok.ok('thread', { thread_id: sent.message_id })).messages).toHaveLength(1);

    budd.clock.now += 1;
    await budd.sweep();
    expect((await grok.ok('thread', { thread_id: sent.message_id })).messages).toEqual([]);
    expect((await claude.ok('thread', { thread_id: sent.message_id })).messages).toEqual([]);
    const reply = await grok.call('send', {
      to: ['claude-desktop/chief-of-staff'],
      from_handle: 'researcher',
      body_md: 'late reply',
      reply_to: sent.message_id,
    });
    expect(reply.text).toMatch(/^unknown_reply_to/);

    const sends = await events('send');
    expect(sends.map((e) => e.detail.message_id)).toContain(sent.message_id);
    expect(await events('inbox_read')).toHaveLength(1);
    expect(await events('retention_purge')).toEqual([
      expect.objectContaining({
        actor: 'system',
        detail: expect.objectContaining({ messages: 1, deliveries: 1 }),
      }),
    ]);
  });

  it('purges expired-but-unread messages and their notices on the same schedule', async () => {
    await send();
    budd.clock.now += DAY;
    await budd.sweep(); // expiry + notice
    budd.clock.now += 30 * DAY;
    await budd.sweep();
    expect((await events('retention_purge'))[0]?.detail).toMatchObject({ messages: 2 });
  });

  it('purges audit rows only after AUDIT_TTL', async () => {
    await budd.close();
    budd = await startTestBudd({ RETENTION_TTL: '30d', AUDIT_TTL: '60d' });
    claude = await budd.connect('claude-desktop');
    expect((await budd.audit()).length).toBeGreaterThan(0);
    budd.clock.now += 60 * DAY - 1;
    await budd.sweep();
    expect((await budd.audit()).map((e) => e.event)).toContain('connection_registered');
    budd.clock.now += 1;
    await budd.sweep();
    expect((await budd.audit()).map((e) => e.event)).not.toContain('connection_registered');
  });
});
