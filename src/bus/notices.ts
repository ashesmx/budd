import type { ExpiredDelivery, NoticeDraft } from '../domain/types.js';
import { formatAddress } from './addressing.js';

/**
 * The notice telling a sender that one of its deliveries expired unread (§8).
 * Notices are leaf nodes: an expired notice never produces another notice.
 * Every word of it is Budd's: the message is named by its id, never quoted,
 * because a notice speaks as Budd and any handle can be a message's sender.
 */
export function expiryNotice(
  expired: ExpiredDelivery,
  opts: { id: string; now: number; deliveryTtlMs: number },
): NoticeDraft | null {
  if (expired.messageType === 'notice') return null;
  if (expired.fromHandle === null) return null; // pre-ADR-0006 data: no mailbox to notify
  const recipient = formatAddress(expired.toConnectionSlug, expired.toHandle);
  const expiredAt = new Date(expired.expiresAt).toISOString();
  return {
    id: opts.id,
    toConnectionId: expired.fromConnectionId,
    toHandle: expired.fromHandle,
    to: formatAddress(expired.fromConnectionSlug, expired.fromHandle),
    subject: 'Not delivered',
    bodyMd: `Your message \`${expired.messageId}\` to \`${recipient}\` expired unread at ${expiredAt}. Budd doesn't redeliver: find it with the thread tool (this notice's thread_id) and send it again if it still matters.`,
    payload: {
      notice: 'delivery_expired',
      message_id: expired.messageId,
      recipient,
      expired_at: expiredAt,
    },
    threadId: expired.threadId,
    replyTo: expired.messageId,
    expiresAt: opts.now + opts.deliveryTtlMs,
  };
}
