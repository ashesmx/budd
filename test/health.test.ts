import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer, type RunningServer } from '../src/server.js';

describe('health endpoint', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves /health over HTTP and creates the control DB in WAL mode', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budd-'));
    server = await startServer(loadConfig({ DATA_DIR: dir, PORT: '0' }));
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', mode: 'local', protocol: '1' });
    expect(fs.existsSync(path.join(dir, 'control.db-wal'))).toBe(true);
  });
});
