import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUrl,
  deliver,
  isPublicAddress,
  signature,
  standardSignature,
  type Outcome,
} from '../src/wakeups/deliver.js';
import { open, seal } from '../src/wakeups/secrets.js';
import { forgetWakeUpKeys } from '../src/storage/sqlite/forgetKeys.js';
import { loadConfig } from '../src/config.js';
import { startTestBudd, type Agent, type TestBudd } from './helpers/harness.js';

describe('where a wake-up may go', () => {
  it('only to public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      '::ffff:127.0.0.1', // IPv4-mapped
      '::ffff:10.0.0.1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '64:ff9b::a00:1', // NAT64 to 10.0.0.1
      '2002:a00:1::1', // 6to4
      '2001:db8::1',
      'not an address',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('only https, with no credentials, on the public internet', () => {
    expect(
      checkUrl('https://api.anthropic.com/v1/claude_code/routines/trig_1/fire'),
    ).toHaveProperty('url');
    for (const [raw, says] of [
      ['http://hooks.example.com/x', /https:\/\//],
      ['https://user:pass@hooks.example.com/x', /Token box/],
      ['https://127.0.0.1/x', /public internet/],
      ['https://[::1]/x', /public internet/],
      ['https://localhost/x', /public internet/],
      ['https://printer.local/x', /public internet/],
      ['https://intranet/x', /public internet/],
      ['ftp://hooks.example.com', /https:\/\//],
      ['https://hooks.example.com:8443/x', /port/],
      ['https://intranet.internal/x', /public internet/],
      ['not a url', /web address/],
    ] as const) {
      const r = checkUrl(raw);
      expect('error' in r && r.error, raw).toMatch(says);
    }
  });

  it('refuses at sending time too, whatever the name resolves to', async () => {
    const body = '{}';
    const req = { signingSecret: null, id: '01TEST', body };
    expect(await deliver({ ...req, url: 'https://10.0.0.1/x', token: null })).toMatchObject({
      ok: false,
      status: expect.stringMatching(/^refused/),
    });
    // A token a header can't carry is refused, never thrown.
    expect(
      await deliver({ ...req, url: 'https://hooks.example.com/x', token: 'a€b' }),
    ).toMatchObject({
      ok: false,
      status: expect.stringMatching(/^refused/),
    });
    // .invalid never resolves (RFC 6761).
    expect(await deliver({ ...req, url: 'https://budd.invalid/x', token: null })).toMatchObject({
      ok: false,
      status: expect.stringMatching(/^failed/),
    });
  });
});

describe('signing', () => {
  it('matches GitHub’s documented X-Hub-Signature-256 example', () => {
    expect(signature("It's a Secret to Everybody", 'Hello, World!')).toBe(
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );
  });

  it('matches the Standard Webhooks example, as Grok checks it', () => {
    expect(
      standardSignature(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });
});

describe('sealing secrets', () => {
  const key = Buffer.alloc(32, 7);
  it('opens only with the same key and context', () => {
    const sealed = seal(key, 'tok_123', 'url a/b');
    expect(sealed.toString('utf8')).not.toContain('tok_123');
    expect(open(key, sealed, 'url a/b')).toBe('tok_123');
    expect(open(key, sealed, 'url a/c')).toBeUndefined();
    expect(open(Buffer.alloc(32, 8), sealed, 'url a/b')).toBeUndefined();
    sealed.writeUInt8((sealed.at(-1) ?? 0) ^ 1, sealed.length - 1);
    expect(open(key, sealed, 'url a/b')).toBeUndefined();
  });
});

let budd: TestBudd;
let claude: Agent;
let grok: Agent;

const URL_ = 'https://hooks.example.com/automations/webhook/abc123secretpath';
const HOSTS = { WAKE_UP_HOSTS: 'hooks.example.com,other.example.com' };
const TOKEN = 'crsr_supersecrettoken9876';
const MAILBOX = '/ui/connections/grok-build/mailboxes/researcher';

beforeEach(async () => {
  budd = await startTestBudd({ SEND_RATE_PER_MIN: '1000', ...HOSTS });
  claude = await budd.connect('claude-desktop');
  grok = await budd.connect('grok-build');
  await claude.ok('inbox_count', { handle: 'chief' });
  await grok.ok('inbox_count', { handle: 'researcher' });
  await budd.setPolicy('grok-build', 'all');
});

afterEach(async () => {
  await budd.close();
});

/** A signed-in browser for the mailbox's pages. */
async function browser() {
  const cookie = await budd.uiCookie();
  const get = async (p: string) => {
    const res = await fetch(`${budd.url}${p}`, { headers: { cookie }, redirect: 'manual' });
    return { status: res.status, body: await res.text(), location: res.headers.get('location') };
  };
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await get(MAILBOX)).body)?.[1] ?? '';
  const post = async (p: string, fields: Record<string, string> = {}) => {
    const res = await fetch(`${budd.url}${p}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
    });
    return { status: res.status, body: await res.text(), location: res.headers.get('location') };
  };
  return { get, post };
}

const setUp = async (fields: Record<string, string> = {}) => {
  const b = await browser();
  const r = await b.post(`${MAILBOX}/wake-up`, {
    url: URL_,
    token: TOKEN,
    retries: '0',
    interval: '5m',
    ...fields,
  });
  expect(r.location, r.body.slice(0, 2000)).toBe(`${MAILBOX}?done=wake_up_set#wake-up`);
  return b;
};

const send = (body = 'hi') =>
  claude.ok('send', { to: ['grok-build/researcher'], from_handle: 'chief', body_md: body });

describe('setting up a wake-up', () => {
  it('is a human’s: shown by host and token hint only, stored sealed, audited by host', async () => {
    const b = await setUp();
    const page = (await b.get(MAILBOX)).body;
    expect(page).toContain('On: wakes <code>hooks.example.com</code>');
    expect(page).toContain('ending <code>9876</code>');
    expect(page).not.toContain('abc123secretpath');
    expect(page).not.toContain(TOKEN);
    expect((await b.get(`${MAILBOX}/wake-up`)).body).not.toContain('abc123secretpath');
    expect((await b.get('/ui/connections/grok-build')).body).toMatch(/data-label="Wake-up">\s*On/);

    // Neither the workspace's file nor the audit log holds the address or token.
    const file = path.join(budd.dataDir, 'workspaces', `${budd.adminCtx.workspace.id}.db`);
    const db = new Database(file, { readonly: true });
    const row = db.prepare('SELECT * FROM wake_ups').get() as Record<string, unknown>;
    db.close();
    expect(JSON.stringify(row)).not.toContain('abc123');
    expect(Buffer.from(row.url_sealed as Buffer).toString('latin1')).not.toContain('abc123');
    expect(Buffer.from(row.token_sealed as Buffer).toString('latin1')).not.toContain('supersecret');
    const audit = (await budd.audit()).find((e) => e.event === 'wake_up_set');
    expect(audit).toMatchObject({
      actor: 'human',
      detail: { mailbox: 'grok-build/researcher', host: 'hooks.example.com' },
    });
    expect(JSON.stringify(await budd.audit())).not.toContain('abc123');

    // Agents never hear of it.
    expect(JSON.stringify(await grok.ok('whoami'))).not.toMatch(/wake/i);
    expect(JSON.stringify(await claude.ok('list_connections'))).not.toMatch(/wake|hooks\.example/i);
  });

  it('refuses a token with characters a header can’t carry', async () => {
    const b = await browser();
    const r = await b.post(`${MAILBOX}/wake-up`, {
      url: URL_,
      token: 'crsr_abc…',
      retries: '0',
      interval: '5m',
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('Enter the token again.');
  });

  it('refuses a Standard Webhooks secret that was cut short', async () => {
    const b = await browser();
    for (const secret of ['whsec_', 'whsec_!!!!', 'whsec_MfKQ9r8G']) {
      const r = await b.post(`${MAILBOX}/wake-up`, {
        url: URL_,
        signing_secret: secret,
        retries: '0',
        interval: '5m',
      });
      expect(r.status).toBe(400);
      expect(r.body).toContain('is cut short');
    }
    const ok = await b.post(`${MAILBOX}/wake-up`, {
      url: URL_,
      signing_secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      retries: '0',
      interval: '5m',
    });
    expect(ok.status).toBe(303);
  });

  it('says what’s wrong with an address, and saves nothing', async () => {
    const b = await browser();
    for (const url of [
      'http://hooks.example.com/x',
      'https://192.168.1.10/hook',
      'https://localhost/x',
    ]) {
      const r = await b.post(`${MAILBOX}/wake-up`, {
        url,
        token: '',
        retries: '0',
        interval: '5m',
      });
      expect(r.status, url).toBe(400);
      expect(r.body, url).toContain('Nothing was saved.');
      expect(r.body, url).toContain(`value="${url}"`);
    }
    expect((await budd.audit()).map((e) => e.event)).not.toContain('wake_up_set');
  });

  it('keeps the address and token when changing only the retries; can drop the token', async () => {
    const b = await setUp();
    await b.post(`${MAILBOX}/wake-up`, { url: '', token: '', retries: '2', interval: '15m' });
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent[0]).toMatchObject({ url: URL_, token: TOKEN });
    await b.post(`${MAILBOX}/wake-up`, {
      url: '',
      token: '',
      no_token: '1',
      retries: '0',
      interval: '5m',
    });
    expect((await b.get(MAILBOX)).body).toContain('With no token');
  });

  it('keeps the token when the same address is typed differently, and keeps its place when only retries change', async () => {
    const b = await setUp({ retries: '0' });
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1);
    await b.post(`${MAILBOX}/wake-up`, {
      url: URL_.replace('hooks.example.com', 'HOOKS.example.com'),
      token: '',
      retries: '2',
      interval: '5m',
    });
    expect((await b.get(MAILBOX)).body).toContain('ending <code>9876</code>');
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1); // the same mail isn't woken for again
    expect((await b.get(MAILBOX)).body).toContain('Worked');
  });

  it('is removed when its connection is archived', async () => {
    await setUp();
    await budd.admin.archive(budd.adminCtx, 'grok-build');
    const removed = (await budd.audit()).filter((e) => e.event === 'wake_up_removed');
    expect(removed.at(-1)).toMatchObject({ detail: { reason: 'connection archived' } });
  });

  it('turns off, and is turned off when its mailbox is archived', async () => {
    const b = await setUp();
    expect((await b.post(`${MAILBOX}/wake-up/remove`)).location).toContain('done=wake_up_removed');
    expect((await b.get(MAILBOX)).body).toContain('Set up a wake-up…');
    await setUp();
    await budd.admin.archiveMailbox(budd.adminCtx, 'grok-build', 'researcher');
    const removed = (await budd.audit()).filter((e) => e.event === 'wake_up_removed');
    expect(removed.at(-1)).toMatchObject({ detail: { reason: 'mailbox archived' } });
  });

  it('a test sends one now and shows its result', async () => {
    const b = await setUp();
    budd.wakeUps.answer = () => ({ ok: false, status: 'HTTP 401' });
    expect((await b.post(`${MAILBOX}/wake-up/test`)).location).toContain('error=wake_up_failed');
    expect(budd.wakeUps.sent).toHaveLength(1);
    const page = (await b.get(MAILBOX)).body.replace(/\s+/g, ' ');
    expect(page).toMatch(/class="status failed">Failed<\/span>/);
    expect(page).toContain('the platform refused it: check the token');
    // A second test right away waits; one that works says so.
    budd.wakeUps.answer = () => ({ ok: true, status: 'HTTP 202' });
    expect((await b.post(`${MAILBOX}/wake-up/test`)).location).toContain('error=test_too_soon');
    budd.clock.now += 31_000;
    expect((await b.post(`${MAILBOX}/wake-up/test`)).location).toContain('done=wake_up_tested');
    expect((await b.get(MAILBOX)).body).toMatch(/class="status active">Worked<\/span>/);
  });
});

describe('when Budd wakes a mailbox', () => {
  it('once for a burst of mail, with no content, and again after the agent has read it', async () => {
    await setUp();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(0); // nothing unread, no wake-up
    await send('secret plans');
    await send('more');
    await budd.sweep();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1);
    const sent = budd.wakeUps.sent[0];
    const body = JSON.parse(sent?.body ?? '{}');
    expect(body).toEqual({
      event: 'budd.mail',
      mailbox: 'grok-build/researcher',
      text: 'You have unread mail on Budd in grok-build/researcher. Call inbox with handle "researcher".',
      id: sent?.id,
      sent_at: new Date(budd.clock.now).toISOString(),
    });
    expect(sent?.signingSecret).toBeNull();
    expect(budd.wakeUps.sent[0]?.body).not.toContain('secret plans');
    expect(budd.wakeUps.sent[0]?.token).toBe(TOKEN);

    budd.clock.now += 60_000;
    await grok.ok('inbox', { handle: 'researcher' });
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1); // read, nothing new
    budd.clock.now += 60_000;
    await send('new');
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(2);
    // Individual wake-ups aren't audited.
    expect((await budd.audit()).filter((e) => e.event.startsWith('wake_up'))).toHaveLength(1);
  });

  it('wakes at once for the first mail, not at the next sweep; within a minute of a wake-up, the sweep sends it', async () => {
    await setUp();
    await send('first');
    await budd.internals.wakeUps?.idle();
    expect(budd.wakeUps.sent).toHaveLength(1); // no sweep needed
    budd.clock.now += 10_000;
    await grok.ok('inbox', { handle: 'researcher' });
    budd.clock.now += 1_000;
    await send('second');
    await budd.internals.wakeUps?.idle();
    expect(budd.wakeUps.sent).toHaveLength(1); // woken 10 seconds ago: it waits
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(2);
  });

  it('sends one wake-up when new mail and the sweep find it due together', async () => {
    await setUp();
    let release = () => {};
    const held = new Promise<Outcome>((resolve) => {
      release = () => {
        resolve({ ok: true, status: 'HTTP 202' });
      };
    });
    budd.wakeUps.answer = () => held as unknown as Outcome; // the platform is slow to answer
    await send('a');
    while (budd.wakeUps.sent.length === 0) await new Promise((r) => setTimeout(r, 5));
    const sweep = budd.internals.wakeUpSweeper.runOnce(); // finds it due: not recorded yet
    await new Promise((r) => setTimeout(r, 20));
    release();
    await sweep;
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1);
  });

  it('retries at the interval while the mail stays unread, up to the maximum', async () => {
    await setUp({ retries: '2', interval: '5m' });
    await send();
    await budd.sweep();
    budd.clock.now += 4 * 60_000;
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1); // not yet
    for (const expected of [2, 3, 3]) {
      budd.clock.now += 5 * 60_000;
      await budd.sweep();
      expect(budd.wakeUps.sent).toHaveLength(expected);
    }
  });

  it('wakes again for new mail after the last ones failed, once a retry interval', async () => {
    await setUp({ retries: '1', interval: '5m' });
    budd.wakeUps.answer = () => ({ ok: false, status: 'HTTP 503' });
    await send();
    await budd.sweep(); // fails
    budd.clock.now += 5 * 60_000;
    await budd.sweep(); // the retry fails too
    expect(budd.wakeUps.sent).toHaveLength(2);
    budd.wakeUps.answer = () => ({ ok: true, status: 'HTTP 202' });
    budd.clock.now += 60_000;
    await send('newer');
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(2); // not until a retry interval has passed
    budd.clock.now += 5 * 60_000;
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(3);
  });

  it('one failing wake-up doesn’t stop the others', async () => {
    await setUp();
    await budd.setPolicy('claude-desktop', 'all');
    await grok.ok('send', {
      to: ['claude-desktop/chief'],
      from_handle: 'researcher',
      body_md: 'x',
    });
    const b = await browser();
    await b.post('/ui/connections/claude-desktop/mailboxes/chief/wake-up', {
      url: 'https://other.example.com/hook',
      token: '',
      retries: '0',
      interval: '5m',
    });
    await send();
    budd.wakeUps.answer = (req) => {
      if (req.url.includes('hooks.example.com')) throw new Error('boom');
      return { ok: true, status: 'HTTP 202' };
    };
    await budd.sweep();
    expect(budd.wakeUps.sent.map((r) => new URL(r.url).host).sort()).toEqual([
      'hooks.example.com',
      'other.example.com',
    ]);
  });

  it('after a partial read, waits a retry interval before waking again', async () => {
    await setUp({ retries: '0', interval: '5m' });
    for (let i = 0; i < 3; i++) await send(`m${String(i)}`);
    await budd.sweep();
    budd.clock.now += 60_000;
    await grok.ok('inbox', { handle: 'researcher', limit: 1 }); // reads one of three
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1);
    budd.clock.now += 5 * 60_000;
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(2);
  });

  it('never wakes a blocked connection or mail that expired', async () => {
    await setUp();
    await budd.admin.block(budd.adminCtx, 'grok-build');
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(0);
  });

  it('a workspace with no key shows its wake-up as unreadable, not an error', async () => {
    const b = await setUp();
    const control = new Database(path.join(budd.dataDir, 'control.db'));
    control.prepare('UPDATE workspaces SET secret_key = NULL').run();
    control.close();
    const page = await b.get(MAILBOX);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Enter the wake-up again.');
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(0);
    // Entering it again gives the workspace a new key, and it works.
    await setUp();
    budd.clock.now += 60 * 60_000;
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(1);
  });

  it('sends nothing it can’t open, and asks for the address again', async () => {
    const b = await setUp();
    const control = new Database(path.join(budd.dataDir, 'control.db'));
    control.prepare('UPDATE workspaces SET secret_key = randomblob(32)').run();
    control.close();
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(0);
    const page = (await b.get(MAILBOX)).body;
    expect(page).toContain('Enter the wake-up again.');
    expect(page.replace(/\s+/g, ' ')).toMatch(/Failed<\/span>.*enter the wake-up again/);
  });
});

describe('signing, ids and limits', () => {
  const SECRET = 'whsec_multica_signing_secret_42';

  it('signs with a secret that’s stored sealed, and drops it with a new address', async () => {
    const b = await setUp({ signing_secret: SECRET, token: '' });
    expect((await b.get(MAILBOX)).body).toContain('With no token, signed.');
    const file = path.join(budd.dataDir, 'workspaces', `${budd.adminCtx.workspace.id}.db`);
    const db = new Database(file, { readonly: true });
    const row = db.prepare('SELECT signing_secret_sealed FROM wake_ups').get() as {
      signing_secret_sealed: Buffer;
    };
    db.close();
    expect(row.signing_secret_sealed.toString('latin1')).not.toContain('multica');
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent[0]?.signingSecret).toBe(SECRET);

    // Kept when only the retries change; a different address needs it again.
    await b.post(`${MAILBOX}/wake-up`, { url: '', token: '', retries: '1', interval: '5m' });
    expect((await b.get(MAILBOX)).body).toContain('signed.');
    await b.post(`${MAILBOX}/wake-up`, {
      url: 'https://other.example.com/hook',
      token: '',
      retries: '0',
      interval: '5m',
    });
    expect((await b.get(MAILBOX)).body).toContain('not signed.');
  });

  it('gives each wake-up its own id, retries included', async () => {
    await setUp({ retries: '1', interval: '5m' });
    await send();
    await budd.sweep();
    budd.clock.now += 5 * 60_000;
    await budd.sweep();
    const [first, retry] = budd.wakeUps.sent;
    expect(first?.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(retry?.id).not.toBe(first?.id);
    expect(JSON.parse(retry?.body ?? '{}').id).toBe(retry?.id);
  });

  it('wakes a mailbox at most WAKE_UPS_PER_HOUR times an hour; tests aside', async () => {
    await budd.close();
    budd = await startTestBudd({ ...HOSTS, WAKE_UPS_PER_HOUR: '2' });
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
    await claude.ok('inbox_count', { handle: 'chief' });
    await grok.ok('inbox_count', { handle: 'researcher' });
    await budd.setPolicy('grok-build', 'all');
    const b = await setUp({ retries: '5', interval: '5m' });
    await send();
    for (let i = 0; i < 6; i++) {
      await budd.sweep();
      budd.clock.now += 5 * 60_000;
    }
    expect(budd.wakeUps.sent).toHaveLength(2);
    expect((await b.post(`${MAILBOX}/wake-up/test`)).location).toContain('done=wake_up_tested');
    expect(budd.wakeUps.sent).toHaveLength(3);
    budd.clock.now += 60 * 60_000; // a new hour
    await send('later');
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(4);
  });
});

describe('WAKE_UP_HOSTS', () => {
  it('takes host names only', () => {
    expect(loadConfig({ WAKE_UP_HOSTS: ' Multica.AI , * ' }).wakeUpHosts).toEqual([
      'multica.ai',
      '*',
    ]);
    expect(loadConfig({ WAKE_UP_HOSTS: '' }).wakeUpHosts).toContain('api.anthropic.com');
    for (const bad of [
      'https://multica.ai/',
      'multica.ai:443',
      'multica.ai.',
      'a b',
      '*.multica.ai',
      'localhost',
    ]) {
      expect(() => loadConfig({ WAKE_UP_HOSTS: bad }), bad).toThrow(/isn't a host name/);
    }
  });

  it('BUDD_SECRET_KEY_PREVIOUS needs a BUDD_SECRET_KEY', () => {
    expect(() => loadConfig({ BUDD_SECRET_KEY_PREVIOUS: 'ab'.repeat(32) })).toThrow(
      /set the new one as BUDD_SECRET_KEY/,
    );
  });

  it('by default, wakes only the platforms the guide covers', async () => {
    await budd.close();
    budd = await startTestBudd();
    grok = await budd.connect('grok-build');
    await grok.ok('inbox_count', { handle: 'researcher' });
    const b = await browser();
    const form = (await b.get(`${MAILBOX}/wake-up`)).body.replace(/\s+/g, ' ');
    expect(form).toContain(
      'Budd only sends wake-ups to <code>api.anthropic.com</code>, <code>api2.cursor.sh</code>, <code>grok.com</code>, <code>multica.ai</code>.',
    );
    const r = await b.post(`${MAILBOX}/wake-up`, {
      url: URL_,
      token: '',
      retries: '0',
      interval: '5m',
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('ask whoever runs Budd to add it to WAKE_UP_HOSTS');
    await b.post(`${MAILBOX}/wake-up`, {
      url: 'https://multica.ai/api/webhooks/autopilots/awt_abc',
      token: '',
      retries: '0',
      interval: '5m',
    });
    expect((await b.get(MAILBOX)).body).toContain('wakes <code>multica.ai</code>');
  });

  it('a host taken off the list isn’t woken, and Connections says so', async () => {
    const b = await setUp();
    const file = path.join(budd.dataDir, 'workspaces', `${budd.adminCtx.workspace.id}.db`);
    const db = new Database(file);
    db.prepare("UPDATE wake_ups SET host = 'gone.example.com'").run();
    db.close();
    await send();
    await budd.sweep();
    expect(budd.wakeUps.sent).toHaveLength(0);
    expect((await b.get(MAILBOX)).body).toContain('Budd no longer sends wake-ups to');
    expect((await b.get(MAILBOX)).body).toContain('Not used yet.'); // its mail still waits
    const connections = (await b.get('/ui')).body.replace(/\s+/g, ' ');
    expect(connections).toContain('A wake-up is failing.');
    expect(connections).toContain('href="/ui/connections/grok-build/mailboxes/researcher#wake-up"');
  });
});

describe('failing wake-ups', () => {
  it('show on Connections and in the mailbox table until one works', async () => {
    const b = await setUp();
    expect((await b.get('/ui')).body).not.toContain('failing');
    budd.wakeUps.answer = () => ({ ok: false, status: 'HTTP 401' });
    await send();
    await budd.sweep();
    expect((await b.get('/ui?view=table')).body).toContain('A wake-up is failing.');
    expect((await b.get('/ui/connections/grok-build')).body).toMatch(
      /data-label="Wake-up">\s*<span class="status failing">Failing/,
    );
    budd.wakeUps.answer = () => ({ ok: true, status: 'HTTP 202' });
    budd.clock.now += 31_000;
    await b.post(`${MAILBOX}/wake-up/test`);
    expect((await b.get('/ui')).body).not.toContain('failing');
  });

  it('show on the map as a bell: a tick when working, ! when failing, plain when paused', async () => {
    const b = await setUp();
    const bell = async () =>
      /data-mb="grok-build\/researcher"[\s\S]*?<g class="wk (wk-\w+)"/.exec(
        (await b.get('/ui?view=map')).body,
      )?.[1];
    const card = async () =>
      (await b.get('/ui?view=map&card=grok-build%2Fresearcher')).body.replace(/\s+/g, ' ');
    expect(await bell()).toBe('wk-ok');
    expect(await card()).toContain('On: wakes <code>hooks.example.com</code>');
    budd.wakeUps.answer = () => ({ ok: false, status: 'HTTP 401' });
    await send();
    await budd.sweep();
    expect(await bell()).toBe('wk-bad');
    expect((await b.get('/ui?view=map')).body).toContain(
      'aria-label="grok-build/researcher: wake-up failing, 1 unread."',
    );
    expect(await card()).toContain('<span class="status failing">Failing</span>: wakes');
    await budd.admin.block(budd.adminCtx, 'grok-build');
    expect(await bell()).toBe('wk-paused');
    expect(await card()).toContain('Paused: wakes');
  });
});

describe('BUDD_SECRET_KEY', () => {
  const KEY = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  let dir: string;

  /** Restarts Budd on the same data with `env`. */
  const restart = async (env: Record<string, string>) => {
    const clock = budd.clock; // time carries on across restarts
    await budd.close();
    budd = await startTestBudd({ ...HOSTS, DATA_DIR: dir, ...env }, clock);
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
  };
  const storedKey = () => {
    const control = new Database(path.join(dir, 'control.db'), { readonly: true });
    const row = control.prepare('SELECT secret_key FROM workspaces').get() as {
      secret_key: Buffer | null;
    };
    control.close();
    return row.secret_key;
  };
  const wakes = async () => {
    const before = budd.wakeUps.sent.length;
    budd.clock.now += 2 * 60 * 60_000;
    await send(`m${String(budd.clock.now)}`);
    await budd.sweep();
    return budd.wakeUps.sent.length > before;
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-test-'));
    await restart({});
    await claude.ok('inbox_count', { handle: 'chief' });
    await grok.ok('inbox_count', { handle: 'researcher' });
    await budd.setPolicy('grok-build', 'all');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a workspace gets a key only with its first wake-up', async () => {
    expect(storedKey()).toBeNull();
    await setUp();
    expect(storedKey()).toHaveLength(32);
  });

  it('locks existing keys at startup, and works with them', async () => {
    await setUp();
    await restart({ BUDD_SECRET_KEY: KEY });
    expect(storedKey()?.length).toBeGreaterThan(32);
    expect(await wakes()).toBe(true);
  });

  it('a missing or wrong key never costs the wake-ups: saving is refused until it’s back', async () => {
    await setUp();
    await restart({ BUDD_SECRET_KEY: KEY });
    for (const env of [{}, { BUDD_SECRET_KEY: OTHER }] as Record<string, string>[]) {
      await restart(env);
      expect(await wakes()).toBe(false);
      const b = await browser();
      expect((await b.get(MAILBOX)).body).toContain('Enter the wake-up again.');
      expect((await b.get('/ui')).body).toContain('A wake-up is failing.');
      const r = await b.post(`${MAILBOX}/wake-up`, {
        url: URL_,
        token: TOKEN,
        retries: '0',
        interval: '5m',
      });
      expect(r.status).toBe(400);
      expect(r.body).toContain('BUDD_SECRET_KEY is missing, or isn');
    }
    await restart({ BUDD_SECRET_KEY: KEY });
    expect(await wakes()).toBe(true);
  });

  it('rotates with BUDD_SECRET_KEY_PREVIOUS', async () => {
    await setUp();
    await restart({ BUDD_SECRET_KEY: KEY });
    await restart({ BUDD_SECRET_KEY: OTHER, BUDD_SECRET_KEY_PREVIOUS: KEY });
    await restart({ BUDD_SECRET_KEY: OTHER });
    expect(await wakes()).toBe(true);
  });

  it('after forget-wake-up-keys, wake-ups can be entered again', async () => {
    await setUp();
    await restart({ BUDD_SECRET_KEY: KEY });
    await restart({});
    expect(forgetWakeUpKeys(dir)).toBe(1);
    await setUp();
    expect(await wakes()).toBe(true);
  });

  it('drops an unused key an older Budd stored for every workspace', async () => {
    const control = new Database(path.join(dir, 'control.db'));
    control.prepare('UPDATE workspaces SET secret_key = randomblob(32)').run();
    control.close();
    await restart({ BUDD_SECRET_KEY: KEY });
    expect(storedKey()).toBeNull();
  });
});

describe('WAKE_UPS=off', () => {
  it('hides the setup and runs no wake-up job', async () => {
    await budd.close();
    budd = await startTestBudd({ WAKE_UPS: 'off' });
    claude = await budd.connect('claude-desktop');
    grok = await budd.connect('grok-build');
    await grok.ok('inbox_count', { handle: 'researcher' });
    const b = await browser();
    expect((await b.get(MAILBOX)).body).not.toContain('Wake-up');
    expect((await b.get(`${MAILBOX}/wake-up`)).status).toBe(404);
    expect(budd.internals.wakeUps).toBeUndefined();
  });
});
