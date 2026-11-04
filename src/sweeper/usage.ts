import type { WorkspaceGateway } from '../storage/gateway.js';
import type { Storage, UsageSample } from '../storage/Storage.js';
import type { SweepJob } from './Sweeper.js';

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
/** How long the operator console keeps each workspace's hourly storage figures. */
export const USAGE_KEPT_MS = 30 * DAY_MS;

/**
 * Once an hour, on the first sweep of an hour not yet measured, records each
 * workspace's storage for the operator console (ADR 0022). A restart neither
 * skips nor repeats an hour.
 */
export function measureStorage(gateway: WorkspaceGateway, storage: Storage): SweepJob {
  return {
    name: 'measure-storage',
    run: async (now) => {
      const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      const last = await storage.console.lastUsageHour();
      if (last !== undefined && last >= hour) return;
      const samples = new Map<string, UsageSample>();
      await gateway.forEachWorkspace(async (workspace, store) => {
        const counted = await store.storedBytes();
        samples.set(workspace.id, {
          messagesBytes: counted.messages,
          auditBytes: counted.audit,
          fileBytes: await storage.workspaceDiskBytes(workspace.id),
        });
      });
      await storage.console.recordUsage(hour, samples, hour - USAGE_KEPT_MS);
    },
  };
}
