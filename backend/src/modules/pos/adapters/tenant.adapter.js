// TEMP: replace with Developer 1's service
import { getContext } from '../../../core/tenantContext.js';

/**
 * Extracts and normalizes tenant context for POS operations.
 *
 * @param {import('express').Request} [req]
 * @returns {{ tenantId: import('mongoose').Types.ObjectId, branchId: import('mongoose').Types.ObjectId|string|null, userId: import('mongoose').Types.ObjectId|null, permissions: object }}
 */
export function getTenantContext(req) {
  const ctx = getContext() || req?.auth || {};
  const tenantId = ctx.tenantId || req?.tenant?._id || null;
  const userId = ctx.userId || req?.user?._id || null;

  // Branch can be specified in request header, query, or defaults to the first branch in user's assigned branches
  const branchHeader = req?.headers?.['x-branch-id'] || req?.query?.branchId;
  const branchId = branchHeader || ctx.branchIds?.[0] || req?.user?.branchIds?.[0] || null;

  const permissions = ctx.role?.grid || req?.user?.role?.grid || {};

  return {
    tenantId,
    branchId,
    userId,
    permissions,
    role: ctx.role || req?.user?.role,
    discountLimit: ctx.discountLimit ?? req?.user?.discountLimit ?? 0,
  };
}

export default { getTenantContext };
