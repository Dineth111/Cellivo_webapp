import mongoose from 'mongoose';
import Branch from '../../branches/Branch.model.js';
import { hasSpecial } from '../../../core/permissions.js';
import { badRequest, forbidden, notFound } from '../../../core/errors.js';

/**
 * The branch a POS request acts on: x-branch-id header, body.branchId or query.branchId,
 * else the user's first branch. 403 unless the user is assigned to it or has view_all_branches;
 * 404 if it is not a branch of this tenant (the query is tenant-scoped).
 *
 * allowAll: with no branch given, a view_all_branches user gets null (= every branch) for reports.
 * branchId: check this branch instead (the branch of an existing invoice, cart or quotation).
 */
export async function resolveBranch(req, { allowAll = false, branchId = null } = {}) {
  const requested = branchId || req.headers['x-branch-id'] || req.body?.branchId || req.query?.branchId;
  const canSeeAll = hasSpecial(req.auth.role, 'view_all_branches');
  if (!requested && allowAll && canSeeAll) return null;

  const id = requested || req.auth.branchIds?.[0];
  if (!id) throw badRequest('No branch selected', 'BRANCH_REQUIRED');
  if (!mongoose.isValidObjectId(id)) throw badRequest('Invalid branch id', 'INVALID_BRANCH');
  if (!canSeeAll && !req.auth.branchIds?.some((b) => String(b) === String(id))) {
    throw forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
  }

  const branch = await Branch.findById(id).lean();
  if (!branch) throw notFound('Branch not found');
  return branch;
}

/** Branch access for an existing record is checked against the record's own branch. */
export async function resolveRecordBranch(req, Model, id, label = 'Record') {
  const doc = await Model.findById(id).select('branchId').lean();
  if (!doc) throw notFound(`${label} not found`);
  return await resolveBranch(req, { branchId: doc.branchId });
}

export default { resolveBranch, resolveRecordBranch };
