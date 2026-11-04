export type BusErrorCode =
  | 'invalid_input'
  | 'invalid_address'
  | 'size'
  | 'handle_required'
  | 'handle_limit'
  | 'mailbox_archived'
  | 'unknown_reply_to'
  | 'unknown_thread'
  | 'rate_limited'
  | 'sender_backlog'
  | 'workspace_full'
  | 'cannot_widen';

/**
 * A failure of the whole call (as opposed to a per-recipient rejection).
 * The message is shown to the agent, so it must say what to do next.
 */
export class BusError extends Error {
  override name = 'BusError';
  constructor(
    readonly code: BusErrorCode,
    message: string,
  ) {
    super(message);
  }
}
