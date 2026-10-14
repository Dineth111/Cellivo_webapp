import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../../../core/config.js';

// Fallback in-memory store for serverless cold-start or disconnected DB
const inMemoryStore = new Map();

// Module-level promise for TTL index creation (runs once, not per request)
let ttlIndexPromise = null;

function ensureTtlIndex() {
  if (!ttlIndexPromise && mongoose.connection?.readyState === 1) {
    const coll = mongoose.connection.collection('public_rate_limits');
    ttlIndexPromise = coll
      .createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, background: true })
      .catch(() => {
        ttlIndexPromise = null; // allow retry if connection wasn't ready
      });
  }
  return ttlIndexPromise;
}

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
    return { allowed: true, count: 1, remaining: limit - 1, resetAt: new Date(now + windowMs) };
  }
  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    count: existing.count,
    remaining: Math.max(0, limit - existing.count),
    resetAt: new Date(existing.expireAt),
  };
}

let testLimits = null;

/**
 * Test-only setter for server-side rate limits.
 * Works strictly when config.env === 'test'.
 */
export function setTestLimits(limits) {
  if (config.env === 'test') {
    testLimits = limits;
  }
}

/**
 * Reset test limits to default server config.
 */
export function resetTestLimits() {
  if (config.env === 'test') {
    testLimits = null;
  }
}

/**
 * Current rate limits from server config or test overrides.
 */
export function getRateLimits() {
  if (config.env === 'test' && testLimits) {
    return {
      ipLimit: testLimits.ipLimit ?? 60,
      failedAttemptLimit: testLimits.failedAttemptLimit ?? 10,
      windowMs: testLimits.windowMs ?? 15 * 60 * 1000,
    };
  }
  return {
    ipLimit: 60,
    failedAttemptLimit: 10,
    windowMs: 15 * 60 * 1000,
  };
}

/**
 * Check and increment rate limit for a given key.
 * Multi-instance rate limit using MongoDB collection with TTL index,
 * falling back to in-memory store if DB is disconnected.
 */
export async function checkRateLimit(key, limit, windowMs = 15 * 60 * 1000) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      return checkInMemory(key, limit, windowMs);
    }

    ensureTtlIndex();

    const coll = mongoose.connection.collection('public_rate_limits');
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
      count,
      remaining: Math.max(0, limit - count),
      resetAt: docExpireAt,
    };
  } catch {
    return checkInMemory(key, limit, windowMs);
  }
}

/**
 * Inspect whether a key is currently rate-limited without incrementing.
 */
export async function isRateLimited(key, limit) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      cleanInMemoryStore();
      const existing = inMemoryStore.get(key);
      if (existing && existing.expireAt > Date.now()) {
        return existing.count >= limit;
      }
      return false;
    }
    const coll = mongoose.connection.collection('public_rate_limits');
    const doc = await coll.findOne({ key, expireAt: { $gt: new Date() } });
    return (doc?.count || 0) >= limit;
  } catch {
    const existing = inMemoryStore.get(key);
    return (existing?.count || 0) >= limit;
  }
}

/**
 * Record a failed attempt for manual lookup.
 */
export async function recordFailedAttempt(key, limit = 10, windowMs = 15 * 60 * 1000) {
  return await checkRateLimit(key, limit, windowMs);
}

/**
 * Reset rate limit for a key (used in tests or manual reset).
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
 * Constant-time string comparison using equal-length SHA-256 buffers.
 */
export function safeCompare(strA, strB) {
  const hashA = crypto.createHash('sha256').update(String(strA ?? '')).digest();
  const hashB = crypto.createHash('sha256').update(String(strB ?? '')).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Hash a string (e.g. for anonymized rate limit keys).
 */
export function hashString(str) {
  return crypto.createHash('sha256').update(String(str ?? '')).digest('hex');
}
