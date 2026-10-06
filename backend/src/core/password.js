import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from './config.js';

// FRS F-01: min 8 characters, at least 1 letter and 1 number. bcrypt ignores bytes past 72.
export function passwordError(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters long';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (max 72 bytes)';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number';
  return null;
}

export const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptCost);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

/** Random single-use token: give `token` to the user, store only `hash`. */
export function newToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
