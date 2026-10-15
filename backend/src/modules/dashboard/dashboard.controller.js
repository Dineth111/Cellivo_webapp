import { getDashboardData } from './services/dashboard.service.js';
import { hasSpecial } from '../../core/permissions.js';
import { resolveBranch } from '../pos/utils/branch.js';

export async function getDashboard(req, res) {
  const { period = 'today' } = req.query;

  // Validate period parameter
  const validPeriods = ['today', 'this_week', 'this_month'];
  const sanitizedPeriod = validPeriods.includes(period) ? period : 'today';

  // Branch scoping:
  // If user has view_all_branches, allow filtering by specific branch or viewing all
  // Otherwise, strictly limit to user's first assigned branch
  let branchId = null;
  if (req.query.branchId) {
    if (hasSpecial(req.auth.role, 'view_all_branches')) {
      const branch = await resolveBranch(req, { branchId: req.query.branchId });
      branchId = branch._id;
    } else {
      branchId = req.auth.branchIds?.[0] || null;
    }
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    branchId = req.auth.branchIds?.[0] || null;
  }

  const data = await getDashboardData({
    tenantId: req.auth.tenantId,
    branchId,
    period: sanitizedPeriod,
    role: req.auth.role,
  });

  res.json({ data });
}
