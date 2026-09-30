import mongoose from 'mongoose';
import { badRequest } from './errors.js';

/** Trimmed string, or undefined for anything else (blocks NoSQL operator objects such as {"$ne": ""}). */
export const str = (v) => (typeof v === 'string' ? v.trim() : undefined);

/** Copy only the listed keys (whitelist for create/update bodies). */
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

export const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v) && String(new mongoose.Types.ObjectId(v)) === v;

export function requireId(v, label = 'id') {
  if (!isId(v)) throw badRequest(`Invalid ${label}`);
  return v;
}

/** Escape user input for use inside a regex. */
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pageParams(query, max = 100) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), max);
  return { page, limit, skip: (page - 1) * limit };
}
