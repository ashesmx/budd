import { describe, expect, it } from 'vitest';
import { expiryNotice } from '../src/bus/notices.js';
import type { ExpiredDelivery } from '../src/domain/types.js';

const expired: ExpiredDelivery = {
  messageId: '01JA0000000000000000000001',
  messageType: 'message',
  threadId: '01JA0000000000000000000001',
  fromConnectionId: 'c1',
  fromConnectionSlug: 'claude-desktop',
  fromHandle: 'chief-of-staff',
  toConnectionSlug: 'grok-build',
  toHandle: 'researcher',
  expiresAt: 0,
};
const opts = { id: '01JA0000000000000000000002', now: 0, deliveryTtlMs: 1000 };

describe('expiryNotice', () => {
  it('addresses the original sender’s handle', () => {
    expect(expiryNotice(expired, opts)).toMatchObject({
      toConnectionId: 'c1',
      toHandle: 'chief-of-staff',
      to: 'claude-desktop/chief-of-staff',
      expiresAt: 1000,
    });
  });

  it('is a leaf: never builds a notice about a notice, whatever its sender', () => {
    expect(expiryNotice({ ...expired, messageType: 'notice' }, opts)).toBeNull();
  });
});
