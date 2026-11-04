import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import { Admin } from './admin/Admin.js';
import { revokeBlocked } from './admin/revokeBlocked.js';
import { LocalLoginState } from './auth/localLogin.js';
import { OidcClient } from './auth/oidc.js';
import { Bus } from './bus/Bus.js';
import { localBaseUrl, type Config } from './config.js';
import { InProcessEventBus } from './events/InProcessEventBus.js';
import { createApp } from './http/app.js';
import { log } from './log.js';
import { WorkspaceGateway } from './storage/gateway.js';
import { SqliteStorage } from './storage/sqlite/SqliteStorage.js';
import type { Storage } from './storage/Storage.js';
import { IntervalSweeper } from './sweeper/IntervalSweeper.js';
import { sweepJobs } from './sweeper/jobs.js';
import { measureStorage } from './sweeper/usage.js';
import { deliver, type Deliver } from './wakeups/deliver.js';
import { WorkspaceKeys } from './wakeups/workspaceKeys.js';
import { WakeUps } from './wakeups/WakeUps.js';
import type { Sweeper } from './sweeper/Sweeper.js';
import type { EventBus } from './events/EventBus.js';
import { BUDD_VERSION } from './version.js';
import { ConnectionKeys } from './admin/keys.js';

/**
 * Registered clients that never complete an authorization are deleted after 30
 * days. Clients cache their registration, so purging sooner could strand one.
 */
const STALE_CLIENT_MS = 30 * 24 * 3600_000;

/**
 * Registration is open to anyone, so never-authorized clients are also capped
 * in number (oldest purged first). Real clients authorize within minutes, so
 * the last hour's registrations are never purged by the cap: at the
 * registration rate limit that's at most 1,800 more.
 */
const MAX_UNAUTHORIZED_CLIENTS = 1000;
const RECENT_CLIENT_MS = 3600_000;

/** How long shutdown waits for in-flight requests before closing their connections. */
const CLOSE_GRACE_MS = 3000;

export interface RunningServer {
  url: string;
  close(): Promise<void>;
  /** In-process handles for tests. */
  internals: {
    gateway: WorkspaceGateway;
    admin: Admin;
    /** Hosted mode: connections with API keys (ADR 0016). */
    keys: ConnectionKeys | undefined;
    sweeper: Sweeper;
    wakeUpSweeper: Sweeper;
    events: EventBus;
    storage: Storage;
    localLogin: LocalLoginState | undefined;
    wakeUps: WakeUps | undefined;
  };
}

export interface ServerOptions {
  /** Injectable clock for tests. */
  clock?: () => number;
  /** Suppress the human-friendly startup banner (tests). */
  quiet?: boolean;
  /** How wake-ups are sent: tests replace the network. */
  deliver?: Deliver;
}

export async function startServer(
  config: Config,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const storage = new SqliteStorage(
    config.dataDir,
    {
      maxConnections: config.limits.maxConnectionsPerWorkspace,
      maxWorkspaceBytes: config.limits.maxWorkspaceBytes,
      maxAuditBytes: config.limits.maxAuditBytes,
      rotateAudit: config.limits.rotateAudit,
    },
    config.keyIdleExpiryMs,
  );
  await storage.init();
  try {
    return await serveWith(storage, config, options);
  } catch (err) {
    await storage.close(); // releases the data directory
    throw err;
  }
}

async function serveWith(
  storage: SqliteStorage,
  config: Config,
  options: ServerOptions,
): Promise<RunningServer> {
  const clock = options.clock ?? Date.now;
  if (config.mode === 'local') await storage.control.ensureLocalWorkspace(clock());

  const gateway = new WorkspaceGateway(storage);
  const bus = new Bus(gateway, config, clock);
  // Hosted mode: blocking a connection kills its tokens (§11).
  const admin = new Admin(
    gateway,
    clock,
    async (workspaceId, connectionId, reason) => {
      if (config.mode !== 'hosted') return;
      const revoked = await revokeBlocked(
        storage.auth,
        (entry) => gateway.appendSystemAudit(workspaceId, entry),
        { workspaceId, connectionId, reason, now: clock() },
      );
      if (revoked.tokens > 0 || revoked.keys > 0) {
        log.info('connection signed out', { reason, connection_id: connectionId, ...revoked });
      }
    },
    config.mode === 'hosted'
      ? (workspaceId) => storage.auth.liveConnectionIds(workspaceId, clock())
      : undefined,
    config.limits.maxHandlesPerConnection,
  );
  const keys = config.hosted ? new ConnectionKeys(gateway, storage.auth, config, clock) : undefined;
  // Every state change is audited, so audit writes drive the UI's live updates.
  const events = new InProcessEventBus();
  storage.onAudit((workspaceId, entry) => {
    events.publish(workspaceId, {
      kind: entry.event,
      at: new Date(entry.at).toISOString(),
      data: {},
    });
  });
  const sweeper = new IntervalSweeper(config.ttl.sweepIntervalMs, clock);
  for (const job of sweepJobs(gateway, config)) sweeper.register(job);
  sweeper.register(measureStorage(gateway, storage));
  // Keys are locked (BUDD_SECRET_KEY) whether or not wake-ups are on.
  const workspaceKeys = new WorkspaceKeys(gateway, storage.control, config.secretKey);
  await workspaceKeys.init();
  const wakeUps = config.wakeUps
    ? new WakeUps(
        gateway,
        workspaceKeys,
        options.deliver ?? deliver,
        {
          hosts: config.wakeUpHosts,
          perHour: config.wakeUpsPerHour,
          sweepIntervalMs: config.ttl.sweepIntervalMs,
        },
        clock,
      )
    : undefined;
  await wakeUps?.init();
  // A send's audit entry is the sign that mail arrived.
  if (wakeUps) {
    storage.onAudit((workspaceId, entry) => {
      if (entry.event === 'send') wakeUps.mailArrived(workspaceId);
    });
  }
  // Their own sweeper: waiting on other people's servers must never delay expiry or purges.
  const wakeUpSweeper = new IntervalSweeper(config.ttl.sweepIntervalMs, clock);
  if (wakeUps) wakeUpSweeper.register({ name: 'wake-ups', run: () => wakeUps.sweep() });
  if (config.hosted) {
    sweeper.register({
      name: 'purge-oauth',
      run: (now) =>
        storage.auth.purge({
          now: now.getTime(),
          staleClientsBefore: now.getTime() - STALE_CLIENT_MS,
          maxUnauthorizedClients: MAX_UNAUTHORIZED_CLIENTS,
          recentClientsAfter: now.getTime() - RECENT_CLIENT_MS,
        }),
    });
  }
  const oidc =
    config.hosted &&
    new OidcClient({
      issuer: config.hosted.oidcIssuer,
      clientId: config.hosted.oidcClientId,
      clientSecret: config.hosted.oidcClientSecret,
      redirectUri: `${config.hosted.publicUrl}/auth/callback`,
      allowedHd: config.hosted.allowedHd,
      allowedEmails: config.hosted.allowedEmails,
      google: config.hosted.google,
      clock,
    });

  const localLogin = config.mode === 'local' ? new LocalLoginState() : undefined;
  await localLogin?.init(storage.auth);
  const shutdown = new AbortController();
  const app = createApp({
    config,
    storage,
    gateway,
    bus,
    admin,
    keys,
    events,
    clock,
    shutdown: shutdown.signal,
    oidc: oidc || undefined,
    localLogin,
    wakeUps,
  });

  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
      resolve(s);
    });
    s.once('error', reject);
  });
  sweeper.start();
  wakeUpSweeper.start();

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = localBaseUrl(config, port);
  log.info('budd listening', {
    url,
    version: BUDD_VERSION,
    mode: config.mode,
    dataDir: config.dataDir,
    ...(config.hosted && {
      clientIpHeader: config.hosted.clientIpHeader ?? 'none',
      ipRatePerMin: config.limits.ipRatePerMin,
    }),
  });
  if (config.mode === 'local' && !options.quiet) {
    console.log(
      [
        '',
        `  Budd is running in local mode at ${url}`,
        '',
        localLogin?.setupCode
          ? `  First, create your UI login:  ${localLogin.setupUrl(url) ?? ''}\n  (This link works once. Until you use it, a new one is printed at every start.)`
          : `  Open the UI to watch messages and manage connections:  ${url}/ui`,
        '',
        '  Give each AI app its own MCP URL. The name after /mcp/ is yours to choose, e.g.:',
        `    Claude Desktop  ${url}/mcp/claude-desktop`,
        `    Claude Code     ${url}/mcp/claude-code`,
        `    Grok Build      ${url}/mcp/grok-build`,
        '',
      ].join('\n'),
    );
  }

  return {
    url,
    internals: {
      gateway,
      admin,
      keys,
      sweeper,
      wakeUpSweeper,
      events,
      storage,
      localLogin,
      wakeUps,
    },
    async close() {
      await Promise.all([sweeper.stop(), wakeUpSweeper.stop()]);
      const http = server as Server;
      const closed = new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
      shutdown.abort(); // end UI live-update streams
      // Keep-alive sockets would otherwise hold close() open. Sockets become idle
      // as their last response (e.g. an ended stream) finishes, so keep sweeping.
      http.closeIdleConnections();
      const idle = setInterval(() => {
        http.closeIdleConnections();
      }, 25);
      // Give in-flight requests a moment, then cut whatever is left.
      const force = setTimeout(() => {
        http.closeAllConnections();
      }, CLOSE_GRACE_MS);
      await closed;
      clearInterval(idle);
      clearTimeout(force);
      // After the last request: one still sending mail could start a wake-up.
      await wakeUps?.stop();
      await storage.close();
    },
  };
}
