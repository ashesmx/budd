import type { Outcome, WakeUpRequest } from '../../src/wakeups/deliver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Admin } from '../../src/admin/Admin.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig, type Config } from '../../src/config.js';
import { SqliteStorage } from '../../src/storage/sqlite/SqliteStorage.js';
import type { AuditRecord, PolicyMode } from '../../src/domain/types.js';
import type { EventBus } from '../../src/events/EventBus.js';
import { startServer, type RunningServer } from '../../src/server.js';
import type { AdminContext } from '../../src/storage/gateway.js';

export interface TestBudd {
  url: string;
  config: Config;
  dataDir: string;
  /** Mutable clock: tests advance `clock.now`. */
  clock: { now: number };
  connect(connection: string): Promise<Agent>;
  /** The human's admin service and context (what the UI calls). */
  admin: Admin;
  adminCtx: AdminContext;
  events: EventBus;
  internals: RunningServer['internals'];
  /** Sets a policy as a human, confirming any widening. */
  setPolicy(connection: string, mode: PolicyMode, allowed?: string[]): Promise<void>;
  /** Wake-ups Budd sent, and how the fake platform answers the next ones. */
  wakeUps: { sent: WakeUpRequest[]; answer: (req: WakeUpRequest) => Outcome };
  /** Runs every sweeper job once at the current test clock. */
  sweep(): Promise<void>;
  /** Local mode: creates a UI login and signs in; returns the session cookie. */
  uiCookie(): Promise<string>;
  /** Audit rows, oldest first. */
  audit(): Promise<AuditRecord[]>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError: boolean;
  text: string;
  /** Parsed JSON result (undefined for errors). */
  data: any;
}

export interface Agent {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Calls a tool and throws if it returned an error; returns the parsed result. */
  ok(tool: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function startTestBudd(
  env: Record<string, string> = {},
  clock = { now: Date.parse('2026-10-15T12:00:00Z') },
): Promise<TestBudd> {
  // A DATA_DIR passed in belongs to the test, which removes it: a restart reuses it.
  const ownDir = env.DATA_DIR === undefined;
  const dataDir = env.DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'budd-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', ...env });
  // Wake-ups never reach the network in tests: they're recorded, and answered as told.
  const wakeUps: TestBudd['wakeUps'] = {
    sent: [],
    answer: () => ({ ok: true, status: 'HTTP 202' }),
  };
  const server: RunningServer = await startServer(config, {
    clock: () => clock.now,
    quiet: true,
    deliver: (req) => {
      wakeUps.sent.push(req);
      return Promise.resolve(wakeUps.answer(req));
    },
  });
  const clients: Client[] = [];
  const { admin, gateway, sweeper, events } = server.internals;
  // Hosted mode has no local workspace; its tests get admin contexts per account.
  const adminCtx =
    config.mode === 'local'
      ? await gateway.adminLocal(clock.now)
      : (undefined as unknown as AdminContext);

  return {
    url: server.url,
    config,
    dataDir,
    clock,
    admin,
    adminCtx,
    events,
    internals: server.internals,
    wakeUps,
    async setPolicy(connection, mode, allowed = []) {
      await admin.setPolicy(adminCtx, connection, { mode, allowed }, { confirmed: true });
    },
    async sweep() {
      await server.internals.wakeUps?.idle();
      await sweeper.runOnce();
      await server.internals.wakeUpSweeper.runOnce();
    },
    async uiCookie() {
      const auth = server.internals.storage.auth;
      const password = 'test-password-1';
      await auth.setLocalLogin({
        accountId: (await auth.getLocalAccountId()) ?? '',
        username: 'tester',
        passwordHash: await hashPassword(password),
        now: clock.now,
      });
      const page = await fetch(`${server.url}/login`);
      const pre = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      const res = await fetch(`${server.url}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: pre },
        body: new URLSearchParams({ _csrf: csrf, username: 'tester', password }).toString(),
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    },
    async audit() {
      return (await admin.audit(adminCtx, 10_000)).reverse();
    },
    async connect(connection) {
      const client = new Client({ name: `test-${connection}`, version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${connection}`)),
      );
      clients.push(client);
      const call = async (
        tool: string,
        args: Record<string, unknown> = {},
      ): Promise<ToolResult> => {
        const res = (await client.callTool({ name: tool, arguments: args })) as {
          isError?: boolean;
          content: { type: string; text: string }[];
        };
        const text = res.content.map((c) => c.text).join('\n');
        const isError = res.isError === true;
        return { isError, text, data: isError ? undefined : JSON.parse(text) };
      };
      return {
        call,
        async ok(tool, args) {
          const r = await call(tool, args);
          if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
          return r.data;
        },
        close: () => client.close(),
      };
    },
    async close() {
      await Promise.all(clients.map((c) => c.close()));
      await server.close();
      if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Storage on `dir` with the default caps, for tests that use it without a server. */
export const testStorage = (dir: string) =>
  new SqliteStorage(
    dir,
    {
      maxConnections: 50,
      maxWorkspaceBytes: 100 * 1024 * 1024,
      maxAuditBytes: 500 * 1024 * 1024,
      rotateAudit: false,
    },
    30 * 86_400_000,
  );
