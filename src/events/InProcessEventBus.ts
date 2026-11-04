import { log } from '../log.js';
import type { BusEvent, EventBus, Unsubscribe } from './EventBus.js';

export class InProcessEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(event: BusEvent) => void>>();

  publish(workspaceId: string, event: BusEvent): void {
    for (const listener of this.listeners.get(workspaceId) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.error('event listener failed', { error: String(err) });
      }
    }
  }

  subscribe(workspaceId: string, listener: (event: BusEvent) => void): Unsubscribe {
    let set = this.listeners.get(workspaceId);
    if (!set) {
      set = new Set();
      this.listeners.set(workspaceId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(workspaceId);
    };
  }
}
