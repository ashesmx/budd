/** Something the UI may want to render live (a send, an inbox read, a policy change...). */
export interface BusEvent {
  kind: string;
  at: string;
  data: Record<string, unknown>;
}

export type Unsubscribe = () => void;

/**
 * Real-time fan-out to UI subscribers. Topics are workspace IDs, so a
 * subscriber only ever sees events from the workspace it subscribed to.
 * v1 is in-process.
 */
export interface EventBus {
  publish(workspaceId: string, event: BusEvent): void;
  subscribe(workspaceId: string, listener: (event: BusEvent) => void): Unsubscribe;
}
