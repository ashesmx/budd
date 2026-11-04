import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAccounts } from '../src/storage/sqlite/accounts.js';
import { Browser, connectClient, startHostedBudd, type HostedBudd } from './helpers/hosted.js';

let budd: HostedBudd;
beforeEach(async () => {
  budd = await startHostedBudd();
});
afterEach(async () => {
  await budd.close();
});

describe('budd accounts', () => {
  it('lists each account with its workspace and connected apps', async () => {
    const alice = new Browser(budd);
    await alice.signIn({ sub: 'alice-sub', email: 'alice@example.com' });
    await connectClient(budd, alice, 'Claude');
    await connectClient(budd, alice, 'Grok');
    const bob = new Browser(budd);
    await bob.signIn({ sub: 'bob-sub', email: 'bob@example.org' });

    expect(listAccounts(budd.dataDir, budd.clock.now)).toEqual([
      expect.objectContaining({
        email: 'alice@example.com',
        workspace: 'alice',
        apps: 2,
        liveApps: 2,
        keys: 0,
      }),
      expect.objectContaining({ email: 'bob@example.org', workspace: 'bob', apps: 0, liveApps: 0 }),
    ]);
    // Once their tokens lapse, the apps are still listed but no longer live.
    expect(listAccounts(budd.dataDir, budd.clock.now + 31 * 86_400_000)[0]).toMatchObject({
      apps: 2,
      liveApps: 0,
    });
  });

  it('signs in a new identity that now holds an old account’s email (no 500, no takeover)', async () => {
    const before = new Browser(budd);
    await before.signIn({ sub: 'leaver-sub', email: 'sam@example.com' });
    await connectClient(budd, before, 'Claude');
    const after = new Browser(budd);
    await after.signIn({ sub: 'new-hire-sub', email: 'sam@example.com' });
    const rows = listAccounts(budd.dataDir, budd.clock.now);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'sam@example.com', workspace: 'sam-2', apps: 0 }),
        expect.objectContaining({ email: null, workspace: 'sam', apps: 1 }),
      ]),
    );
  });

  it('runs from the CLI', async () => {
    const alice = new Browser(budd);
    await alice.signIn({ sub: 'alice-sub', email: 'alice@example.com' });
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', path.resolve('src/cli.ts'), 'accounts'],
      { env: { ...process.env, DATA_DIR: budd.dataDir } },
    );
    expect(stdout).toMatch(/^EMAIL\s+WORKSPACE\s+CREATED\s+APPS \(LIVE\)\s+API KEYS$/m);
    expect(stdout).toMatch(/^alice@example\.com\s+alice\s+2026-10-15\s+0 \(0\)\s+0$/m);
  }, 30_000);
});
