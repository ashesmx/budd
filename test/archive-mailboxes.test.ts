import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

beforeEach(async () => {
  budd = await startTestBudd({ MAX_HANDLES_PER_CONNECTION: '2' });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await claude.ok('inbox_count', { handle: 'chief' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await budd.setPolicy('grok-build', 'all');
  await budd.setPolicy('claude-desktop', 'all');
});

afterEach(async () => {
  await budd.close();
});

const archive = () => budd.admin.archiveMailbox(budd.adminCtx, 'grok-build', 'researcher');
const send = (to = 'grok-build/researcher') =>
  claude.ok('send', { to: [to], from_handle: 'chief', body_md: 'hello' });

/** A UI session that posts the mailbox page's forms. */
async function ui() {
  const cookie = await budd.uiCookie();
  const page = await (
    await fetch(`${budd.url}/ui/connections/grok-build/mailboxes/researcher`, {
      headers: { cookie },
    })
  ).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
  const post = (verb: string) =>
    fetch(`${budd.url}/ui/connections/grok-build/mailboxes/researcher/${verb}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
  const get = async (path: string) =>
    (await fetch(`${budd.url}${path}`, { headers: { cookie } })).text();
  return { page, post, get };
}

describe('archiving a mailbox', () => {
  it('a human archives and restores it from its page, audited', async () => {
    const b = await ui();
    expect(b.page).toContain('action="/ui/connections/grok-build/mailboxes/researcher/archive"');
    const archived = await b.post('archive');
    expect(archived.status).toBe(303);
    expect(archived.headers.get('location')).toBe(
      '/ui/connections/grok-build/mailboxes/researcher?done=mailbox_archived',
    );
    const page = await b.get(archived.headers.get('location') ?? '');
    expect(page).toMatch(/<strong>Archived <time/); // the standing notice, not a second flash
    expect(page).toContain('action="/ui/connections/grok-build/mailboxes/researcher/restore"');
    // Hidden from the lists, still reachable from its connection.
    expect(await b.get('/ui?view=table')).not.toContain('mailboxes/researcher"');
    expect(await b.get('/ui/connections/grok-build')).toMatch(
      /Archived:\s*<a href="\/ui\/connections\/grok-build\/mailboxes\/researcher"/,
    );

    expect((await b.post('restore')).headers.get('location')).toContain('done=mailbox_restored');
    const events = (await budd.audit()).filter((e) => e.event.startsWith('mailbox_'));
    expect(events).toMatchObject([
      { event: 'mailbox_archived', actor: 'human', detail: { mailbox: 'grok-build/researcher' } },
      { event: 'mailbox_restored', actor: 'human', detail: { mailbox: 'grok-build/researcher' } },
    ]);
  });

  it('refuses new mail, telling the sender it was archived', async () => {
    await archive();
    const sent = await send();
    expect(sent.results[0]).toMatchObject({ status: 'rejected', reason: 'mailbox_archived' });
    expect(sent.results[0].detail).toMatch(/archived by a human/);
  });

  it('no agent can use it, or bring it back by polling or claiming it', async () => {
    await archive();
    for (const [tool, args] of [
      ['inbox', { handle: 'researcher' }],
      ['inbox_count', { handle: 'researcher' }],
      ['claim_handle', { handle: 'researcher' }],
      ['send', { to: ['claude-desktop/chief'], from_handle: 'researcher', body_md: 'x' }],
    ] as const) {
      const r = await grok.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/archived by a human.*Only a human can restore it/s);
    }
    // Nothing was sent from it, and it's still archived.
    expect((await claude.ok('inbox_count', { handle: 'chief' })).unread).toBe(0);
    const listed = await claude.ok('list_connections');
    const grokListed = listed.connections.find(
      (c: { connection: string }) => c.connection === 'grok-build',
    );
    expect(grokListed.handles).toEqual([]);
    expect((await grok.ok('whoami')).handles_seen).toEqual([]);
  });

  it('keeps its unread mail until it expires as usual, with the usual notice', async () => {
    await claude.ok('send', {
      to: ['grok-build/researcher'],
      from_handle: 'chief',
      body_md: 'before',
      ttl: '1m',
    });
    await archive();
    budd.clock.now += 120_000;
    await budd.sweep();
    expect((await budd.audit()).map((e) => e.event)).toContain('delivery_expired');
    const notices = await claude.ok('inbox', { handle: 'chief' });
    expect(notices.messages[0]?.type).toBe('notice');
  });

  it('stops counting towards the cap; restoring is refused while the connection is full', async () => {
    await grok.ok('claim_handle', { handle: 'second' });
    expect((await grok.call('claim_handle', { handle: 'third' })).isError).toBe(true);
    await archive();
    await grok.ok('claim_handle', { handle: 'third' });
    await expect(
      budd.admin.restoreMailbox(budd.adminCtx, 'grok-build', 'researcher'),
    ).rejects.toMatchObject({ code: 'mailbox_limit' });
    const b = await ui();
    const r = await b.post('restore');
    expect(r.headers.get('location')).toBe(
      '/ui/connections/grok-build/mailboxes/researcher?error=mailbox_limit',
    );
  });

  it('refuses archiving a mailbox that doesn’t exist', async () => {
    await expect(
      budd.admin.archiveMailbox(budd.adminCtx, 'grok-build', 'nobody'),
    ).rejects.toMatchObject({ code: 'unknown_mailbox' });
    expect(await budd.admin.archiveMailbox(budd.adminCtx, 'grok-build', 'researcher')).toBe(true);
    expect(await budd.admin.archiveMailbox(budd.adminCtx, 'grok-build', 'researcher')).toBe(false);
  });
});
