import crypto from 'crypto';
import mongoose from 'mongoose';

// Fallback in-memory store for serverless cold-start or disconnected DB
const inMemoryStore = new Map();

/**
 * Clean up expired in-memory entries periodically
 */
function cleanInMemoryStore() {
  const now = Date.now();
  for (const [key, val] of inMemoryStore.entries()) {
    if (val.expireAt <= now) {
      inMemoryStore.delete(key);
    }
  }
}

/**
 * In-memory rate limit check (fallback)
 */
function checkInMemory(key, limit, windowMs) {
  cleanInMemoryStore();
  const now = Date.now();
  const existing = inMemoryStore.get(key);
  if (!existing || existing.expireAt <= now) {
    inMemoryStore.set(key, { count: 1, expireAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: new Date(now + windowMs) };
  }
  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: new Date(existing.expireAt),
  };
}

/**
 * Multi-instance rate limit check using MongoDB collection with TTL index
 * and graceful fallback to in-memory store.
 */
export async function checkRateLimit(key, limit = 10, windowMs = 15 * 60 * 1000) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      return checkInMemory(key, limit, windowMs);
    }

    const coll = mongoose.connection.collection('public_rate_limits');
    // Ensure TTL index exists (idempotent, fast)
    try {
      await coll.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, background: true });
    } catch {
      // index already exists or creation in progress
    }

    const now = new Date();
    const expireAt = new Date(now.getTime() + windowMs);

    const res = await coll.findOneAndUpdate(
      { key },
      {
        $inc: { count: 1 },
        $setOnInsert: { expireAt, createdAt: now },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const doc = res?.value || res;
    const count = doc?.count || 1;
    const docExpireAt = doc?.expireAt || expireAt;
    const allowed = count <= limit;

    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetAt: docExpireAt,
    };
  } catch {
    // If MongoDB error occurs, fallback to in-memory store
    return checkInMemory(key, limit, windowMs);
  }
}

/**
 * Reset rate limit for a key (used in tests or manual reset)
 */
export async function resetRateLimit(key) {
  inMemoryStore.delete(key);
  try {
    if (mongoose.connection?.readyState === 1) {
      await mongoose.connection.collection('public_rate_limits').deleteMany({ key });
    }
  } catch {
    // ignore
  }
}

/**
 * Constant-time string comparison using SHA-256 hashes of equal length
 */
export function safeCompare(strA, strB) {
  const hashA = crypto.createHash('sha256').update(String(strA ?? '')).digest();
  const hashB = crypto.createHash('sha256').update(String(strB ?? '')).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Hash a string (e.g. for anonymized rate limit keys)
 */
export function hashString(str) {
  return crypto.createHash('sha256').update(String(str ?? '')).digest('hex');
}
