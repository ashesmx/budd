import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startupHint } from '../src/main.js';
import { startServer } from '../src/server.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-startup-'));
  cleanup.push(() => {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
};

/** Starts the server expecting it to fail; returns the operator-facing hint. */
async function failingStart(env: Record<string, string>) {
  const config = loadConfig({ DATA_DIR: tempDir(), PORT: '0', ...env });
  const err = await startServer(config, { quiet: true }).then(
    async (s) => {
      await s.close();
      throw new Error('started unexpectedly');
    },
    (e: unknown) => e,
  );
  return startupHint(err, config);
}

describe('startup failures an operator can fix get one clear line', () => {
  it('a port already in use names PORT', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    cleanup.push(
      () =>
        new Promise<void>((r) => {
          blocker.close(() => {
            r();
          });
        }),
    );
    const port = (blocker.address() as net.AddressInfo).port;
    expect(await failingStart({ PORT: String(port) })).toMatch(
      new RegExp(`port ${String(port)} .* already in use.*set PORT`),
    );
  });

  it.skipIf(process.getuid?.() === 0)('an unwritable data directory names DATA_DIR', async () => {
    const parent = tempDir();
    fs.chmodSync(parent, 0o500);
    expect(await failingStart({ DATA_DIR: path.join(parent, 'data') })).toMatch(
      /can't write to its data directory .*DATA_DIR/,
    );
  });

  it('a privileged port says so, not that the data directory is wrong', () => {
    const err = Object.assign(new Error('listen EACCES'), { code: 'EACCES', syscall: 'listen' });
    expect(startupHint(err, loadConfig({ PORT: '443' }))).toMatch(/port 443 .*below 1024/);
  });

  it('other errors are left alone (a stack trace is the right output)', () => {
    expect(startupHint(new Error('boom'), loadConfig({}))).toBeUndefined();
  });
});
