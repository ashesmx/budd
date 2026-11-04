import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secrets a workspace stores (wake-up URLs and tokens), sealed with its own key
 * from the control database: AES-256-GCM, a random 12-byte nonce each time,
 * and `context` (what the value is and whose) as associated data, so a sealed
 * value copied to another row or workspace won't open.
 */
export function seal(key: Buffer, plaintext: string, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The sealed value, or undefined if it won't open: another key, another context, or tampered with. */
export function open(key: Buffer, sealed: Buffer, context: string): string | undefined {
  if (sealed.length < 28) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
