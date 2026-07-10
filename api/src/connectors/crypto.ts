import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * AES-256-GCM credential sealing. The key comes from APP_ENCRYPTION_KEY (any string — hashed
 * to 32 bytes). Set a strong, stable value in production; rotating it invalidates stored creds.
 * Format: base64(iv).base64(authTag).base64(ciphertext)
 */
function key(): Buffer {
  // No constant fallback — a committed default in a public repo would let anyone decrypt every
  // stored cloud credential. Startup fails closed (main.ts checkSecrets) before this is reached.
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32 || secret.includes('change-me')) {
    throw new Error('APP_ENCRYPTION_KEY is missing or weak (need a strong, stable 32+ char value). Generate: openssl rand -hex 32');
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptJson(obj: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptJson<T = Record<string, string>>(blob: string): T {
  const [ivB64, tagB64, dataB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed encrypted credentials');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
