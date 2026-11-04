import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDataDir } from '../src/storage/sqlite/backup.js';
import { startTestBudd, type TestBudd } from './helpers/harness.js';

let budd: TestBudd | undefined;
const tmp: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-backup-'));
  tmp.push(d);
  return d;
};
afterEach(async () => {
  await budd?.close();
  budd = undefined;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function withMessage() {
  budd = await startTestBudd();
  const claude = await budd.connect('claude-desktop');
  const grok = await budd.connect('grok-build');
  await grok.ok('inbox_count', { handle: 'researcher' });
  await budd.setPolicy('grok-build', 'all');
  await claude.ok('send', { to: ['grok-build/researcher'], from_handle: 'cos', body_md: 'kept' });
  return budd;
}

describe('budd backup', () => {
  it('copies every database while Budd is running, and the copy restores', async () => {
    const live = await withMessage();
    const dest = path.join(tempDir(), 'snapshot');
    const results = await backupDataDir(live.dataDir, dest);
    expect(results.map((r) => path.relative(dest, r.file)).sort()).toEqual(
      ['control.db', path.join('workspaces', `${live.adminCtx.workspace.id}.db`)].sort(),
    );
    // Only the databases: no WAL/SHM files left over from checking the copies.
    expect(fs.readdirSync(dest).filter((f) => /-(wal|shm)$/.test(f))).toEqual([]);
    // Budd keeps working during and after the backup.
    await live.connect('claude-code');

    // Restore: start a fresh Budd on the backup.
    await live.close();
    budd = await startTestBudd({ DATA_DIR: dest });
    const grok = await budd.connect('grok-build');
    const inbox = await grok.ok('inbox', { handle: 'researcher' });
    expect(inbox.messages.map((m: { body_md: string }) => m.body_md)).toEqual(['kept']);
  });

  it('refuses to overwrite a non-empty directory, or to back up nothing', async () => {
    const live = await withMessage();
    const dest = tempDir();
    fs.writeFileSync(path.join(dest, 'something'), 'x');
    await expect(backupDataDir(live.dataDir, dest)).rejects.toThrow(/not empty/);
    await expect(backupDataDir(tempDir(), path.join(tempDir(), 'x'))).rejects.toThrow(
      /No Budd data found/,
    );
  });

  it('runs from the CLI', async () => {
    const live = await withMessage();
    const dest = path.join(tempDir(), 'cli');
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', path.resolve('src/cli.ts'), 'backup', dest],
      { env: { ...process.env, DATA_DIR: live.dataDir } },
    );
    expect(stdout).toMatch(/Backed up 2 database\(s\)/);
    expect(fs.existsSync(path.join(dest, 'control.db'))).toBe(true);
    // Private to Budd's OS user: the directory and the files the CLI wrote.
    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dest, 'control.db')).mode & 0o077).toBe(0);
  }, 30_000);

  it('reads DATA_DIR from .env, as `npm start` does', async () => {
    const live = await withMessage();
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, '.env'), `DATA_DIR=${live.dataDir}\n`);
    const env = { ...process.env };
    delete env.DATA_DIR;
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', path.resolve('src/cli.ts'), 'backup', path.join(cwd, 'out')],
      { cwd, env },
    );
    expect(stdout).toContain(`from ${live.dataDir}`);
  }, 30_000);

  it('refuses an empty DATA_DIR, as the server does', async () => {
    await expect(
      promisify(execFile)('npx', ['tsx', path.resolve('src/cli.ts'), 'accounts'], {
        cwd: tempDir(),
        env: { ...process.env, DATA_DIR: '' },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('DATA_DIR is empty') });
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)(
    'says so in one line when .env can’t be read',
    async () => {
      const cwd = tempDir();
      fs.writeFileSync(path.join(cwd, '.env'), 'DATA_DIR=./x\n', { mode: 0o000 });
      await expect(
        promisify(execFile)('npx', ['tsx', path.resolve('src/cli.ts'), 'accounts'], { cwd }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("Budd can't read .env") });
    },
    30_000,
  );
});

describe('data directory permissions', () => {
  it('makes the data directory private to Budd’s OS user, tightening an existing one', async () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    budd = await startTestBudd({ DATA_DIR: dir });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    await budd.connect('claude-code'); // creates the workspace database
    expect(fs.statSync(path.join(dir, 'workspaces')).mode & 0o777).toBe(0o700);
  });
});
