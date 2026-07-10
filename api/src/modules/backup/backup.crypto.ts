import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

/**
 * Passphrase-encrypted backup bundle (independent of APP_ENCRYPTION_KEY so backups are portable).
 * PBKDF2-SHA256 (200k iterations) derives the key; AES-256-GCM seals the JSON. The plaintext secrets
 * only exist inside this passphrase-protected envelope.
 */
const ITER = 200_000;
function derive(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, ITER, 32, 'sha256');
}

export function sealBackup(obj: unknown, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  return JSON.stringify(
    {
      format: 'mcmf-backup',
      v: 1,
      kdf: `pbkdf2-sha256-${ITER}`,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
    },
    null,
    2,
  );
}

export function openBackup(fileStr: string, passphrase: string): any {
  let f: any;
  try { f = JSON.parse(fileStr); } catch { throw new Error('not a valid backup file (bad JSON)'); }
  if (f?.format !== 'mcmf-backup') throw new Error('not an MCMF backup file');
  const decipher = createDecipheriv('aes-256-gcm', derive(passphrase, Buffer.from(f.salt, 'base64')), Buffer.from(f.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
  try {
    const dec = Buffer.concat([decipher.update(Buffer.from(f.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch {
    throw new Error('wrong passphrase or corrupted backup');
  }
}
