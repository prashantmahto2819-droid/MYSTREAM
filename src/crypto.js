import crypto from 'node:crypto';

// Stream keys are stored encrypted (AES-256-GCM) so a copied database file
// does not leak them. The key is derived from APP_SECRET.
export function makeVault(secret) {
  const key = crypto.scryptSync(secret, 'vivid-stream-vault-v1', 32);
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt(blob) {
      const raw = Buffer.from(blob, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return safeEqual(hash.toString('hex'), hashHex);
}
