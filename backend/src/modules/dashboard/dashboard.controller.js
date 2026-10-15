import { getDashboardData } from './services/dashboard.service.js';
import { hasSpecial } from '../../core/permissions.js';
import { resolveBranch } from '../pos/utils/branch.js';
import { forbidden } from '../../core/errors.js';

export async function getDashboard(req, res) {
  const { period = 'today' } = req.query;

  // Validate period parameter
  const validPeriods = ['today', 'this_week', 'this_month'];
  const sanitizedPeriod = validPeriods.includes(period) ? period : 'today';

  // Branch scoping (fail-closed):
  let branchId = null;
  const canViewAll = hasSpecial(req.auth.role, 'view_all_branches');

  if (canViewAll) {
    if (req.query.branchId) {
      const branch = await resolveBranch(req, { branchId: req.query.branchId });
      branchId = branch._id;
    }
  } else {
    const userBranchIds = (req.auth.branchIds || []).map((b) => String(b));
    if (userBranchIds.length === 0) {
      throw forbidden('No branch assigned to user');
    }
    if (req.query.branchId) {
      const requestedId = String(req.query.branchId);
      if (!userBranchIds.includes(requestedId)) {
        throw forbidden('Access to requested branch is forbidden');
      }
      branchId = requestedId;
    } else {
      branchId = userBranchIds[0];
    }
  }

  const data = await getDashboardData({
    tenantId: req.auth.tenantId,
    branchId,
    period: sanitizedPeriod,
    role: req.auth.role,
  });

  res.json({ data });
}
