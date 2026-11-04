import { monotonicFactory } from 'ulid';
import { expiryNotice } from '../bus/notices.js';
import type { Config } from '../config.js';
import { SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import { log } from '../log.js';
import type { WorkspaceGateway } from '../storage/gateway.js';
import type { SweepJob } from './Sweeper.js';

/** The three maintenance jobs (§8), each run across every workspace. */
export function sweepJobs(gateway: WorkspaceGateway, config: Config): SweepJob[] {
  const newId = monotonicFactory();
  const { ttl } = config;
  return [
    {
      name: 'expire-deliveries',
      run: (now) =>
        gateway.forEachWorkspace(async (workspace, store) => {
          const nowMs = now.getTime();
          const expired = await store.expireDeliveries({
            now: nowMs,
            systemSlug: SYSTEM_CONNECTION_SLUG,
            notice: (e) =>
              expiryNotice(e, { id: newId(nowMs), now: nowMs, deliveryTtlMs: ttl.deliveryMs }),
          });
          if (expired > 0) log.info('deliveries expired', { workspace: workspace.slug, expired });
        }),
    },
    {
      name: 'purge-retention',
      run: (now) =>
        gateway.forEachWorkspace(async (workspace, store) => {
          const purged = await store.purgeMessages({
            cutoff: now.getTime() - ttl.retentionMs,
            now: now.getTime(),
          });
          if (purged > 0) log.info('messages purged', { workspace: workspace.slug, purged });
        }),
    },
    {
      name: 'purge-audit',
      run: (now) =>
        gateway.forEachWorkspace(async (workspace, store) => {
          const purged = await store.purgeAudit(now.getTime() - ttl.auditMs);
          if (purged > 0) log.info('audit rows purged', { workspace: workspace.slug, purged });
        }),
    },
  ];
}
