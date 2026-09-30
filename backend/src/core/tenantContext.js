import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

const als = new AsyncLocalStorage();

const toId = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/** Run fn with a tenant context. ctx: { tenantId, userId, sessionId, branchIds, role, ip, device, ... } */
export const runWithContext = (ctx, fn) => als.run({ ...ctx, tenantId: toId(ctx.tenantId) }, fn);

/**
 * Explicit opt-out for platform-level code (login lookup by email, platform admin).
 * Everything inside fn is UNSCOPED. Keep the callback as small as possible.
 */
export const runAsPlatform = (fn) => als.run({ platform: true }, fn);

export const getContext = () => als.getStore();

/** Current tenant id (ObjectId). Throws if there is no tenant context. */
export function currentTenantId() {
  const ctx = als.getStore();
  if (!ctx?.tenantId) throw new Error('No tenant context');
  return ctx.tenantId;
}
