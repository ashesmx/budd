import type { MessageView } from '../domain/types.js';
import { TRUST_NOTICE } from './trust.js';

export interface Envelope {
  id: string;
  type: 'message' | 'notice';
  from: {
    workspace: string;
    connection: string;
    connection_verified: true;
    handle: string | null;
    handle_verified: false;
  };
  trust_notice: string;
  subject: string | null;
  body_md: string | null;
  payload: Record<string, unknown> | null;
  thread_id: string;
  reply_to: string | null;
  created_at: string;
  expires_at: string;
}

export function toEnvelope(m: MessageView, workspaceSlug: string): Envelope {
  return {
    id: m.id,
    type: m.type,
    from: {
      workspace: workspaceSlug,
      connection: m.fromConnectionSlug,
      connection_verified: true,
      handle: m.fromHandle,
      handle_verified: false,
    },
    trust_notice: TRUST_NOTICE,
    subject: m.subject,
    body_md: m.bodyMd,
    payload: m.payload,
    thread_id: m.threadId,
    reply_to: m.replyTo,
    created_at: new Date(m.createdAt).toISOString(),
    expires_at: new Date(m.expiresAt).toISOString(),
  };
}
