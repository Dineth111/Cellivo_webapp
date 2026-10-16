import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const envKey = process.env.REPAIR_PASSCODE_KEY;
  if (!envKey) return null;
  // Derive fixed 32-byte key using SHA-256
  return crypto.createHash('sha256').update(String(envKey)).digest();
}

export function hasPasscodeKey() {
  return Boolean(process.env.REPAIR_PASSCODE_KEY);
}

/**
 * Encrypts a device passcode using AES-256-GCM.
 * Returns { encrypted, iv, tag } or null if key is missing or passcode is empty.
 */
export function encryptPasscode(passcode) {
  if (!passcode) return null;
  const key = getKey();
  if (!key) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(passcode), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag,
  };
}

/**
 * Decrypts a device passcode using AES-256-GCM.
 * Returns plaintext or null on error or missing key.
 */
export function decryptPasscode({ encrypted, iv, tag }) {
  if (!encrypted || !iv || !tag) return null;
  const key = getKey();
  if (!key) return null;

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

export default {
  hasPasscodeKey,
  encryptPasscode,
  decryptPasscode,
};
