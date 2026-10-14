import { getDashboardData } from './services/dashboard.service.js';
import { hasSpecial } from '../../core/permissions.js';
import { resolveBranch } from '../pos/utils/branch.js';

export async function getDashboard(req, res) {
  const { period = 'today' } = req.query;

  // Validate period parameter
  const validPeriods = ['today', 'this_week', 'this_month'];
  const sanitizedPeriod = validPeriods.includes(period) ? period : 'today';

  // Branch isolation
  const branchFilter = {};
  if (req.query.branchId) {
    if (hasSpecial(req.auth.role, 'view_all_branches')) {
      const branch = await resolveBranch(req, { branchId: req.query.branchId });
      branchFilter.branchId = branch._id;
    } else {
      // Force user's assigned branch
      const userBranch = req.auth.branchIds?.[0];
      if (userBranch) {
        branchFilter.branchId = userBranch;
      }
    }
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    if (req.auth.branchIds?.length) {
      branchFilter.branchId = { $in: req.auth.branchIds };
    }
  }

  const allowCostMargin = hasSpecial(req.auth.role, 'view_cost_margin');

  const data = await getDashboardData({
    tenantId: req.auth.tenantId,
    branchFilter,
    period: sanitizedPeriod,
    allowCostMargin,
  });

  res.json({ data });
}
