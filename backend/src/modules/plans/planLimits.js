import Branch from '../branches/Branch.model.js';
import User from '../users/User.model.js';
import Tenant from '../tenants/Tenant.model.js';
import { getPlan, cheapestPlanWith } from './plans.service.js';
import { runAsPlatform, currentTenantId } from '../../core/tenantContext.js';
import { forbidden, wrap, AppError } from '../../core/errors.js';

/**
 * Plan limits and feature flags, enforced on the SERVER (SRS 2.3, section 6).
 * Use after `protect` (it needs req.tenant). Messages are the FRS V-09 to V-11 texts.
 *
 *   router.use(protect, subscriptionGuard);
 *   router.post('/', requireFeature('repairs'), wrap(create));
 *   await assertBranchLimit(req.tenant);   // inside a handler
 */
export const DEFAULT_PLAN = 'starter'; // legacy tenants that never chose a plan

/** The current tenant's document, for code that runs in a service without req (tenant context required). */
export const tenantFromContext = () => {
  const id = currentTenantId(); // read it before runAsPlatform replaces the context
  return runAsPlatform(async () => await Tenant.findById(id).lean());
};

export const planOf = (tenant) => getPlan(tenant.planCode ?? DEFAULT_PLAN);

export const hasFeature = (plan, feature) => plan.features.includes(feature);

export async function featureError(feature) {
  const needed = await cheapestPlanWith(feature);
  const label = feature.replace(/_/g, ' ');
  const from = needed ? `from the ${needed.name} plan` : 'on a higher plan';
  return forbidden(`This feature (${label}) is available ${from}. Upgrade to use it.`, 'FEATURE_NOT_IN_PLAN');
}

/** Route middleware: 403 unless the tenant's plan includes the feature. */
export const requireFeature = (feature) =>
  wrap(async (req, res, next) => {
    if (!hasFeature(await planOf(req.tenant), feature)) throw await featureError(feature);
    next();
  });

export const branchLimit = (plan, tenant) => tenant.branchLimitOverride ?? plan.branchLimit; // null = unlimited

/** Throws (V-09) when adding one more active branch would exceed the plan. Tenant context required. */
export async function assertBranchLimit(tenant, adding = 1) {
  const plan = await planOf(tenant);
  const limit = branchLimit(plan, tenant);
  if (limit === null) return;
  if ((await Branch.countDocuments({ isActive: true })) + adding > limit) {
    throw forbidden(`Your plan allows ${limit} branch${limit === 1 ? '' : 'es'}. Upgrade to add more.`, 'PLAN_LIMIT');
  }
}

/** Throws when inviting one more active user would exceed the plan, or the role is not allowed on it. */
export async function assertCanAddUser(tenant, roleKey) {
  const plan = await planOf(tenant);
  if (plan.roleKeys && roleKey && !plan.roleKeys.includes(roleKey)) {
    throw forbidden(`The ${plan.name} plan only allows these roles: ${plan.roleKeys.join(', ')}. Upgrade to use more roles.`, 'PLAN_LIMIT');
  }
  if (plan.userLimit !== null && (await User.countDocuments({ isActive: true })) + 1 > plan.userLimit) {
    throw forbidden(`Your plan allows ${plan.userLimit} users. Upgrade to add more.`, 'PLAN_LIMIT');
  }
}

// ---- suspended / expired / cancelled tenants (FRS F-02) ----
const READ_ONLY = new Set(['expired', 'suspended', 'cancelled']);
export const SUSPENDED_MESSAGE = 'Your subscription is unpaid. Pay now to continue billing. You can still view and export data.';

/**
 * Mount after `protect` on every shop route. Suspended, expired and cancelled shops are read-only
 * (they can view and export data, and pay); archived shops can only reach billing.
 * Billing and auth routes are not behind this guard.
 */
export function subscriptionGuard(req, res, next) {
  const status = req.tenant?.status;
  if (status === 'archived') return next(new AppError(402, 'This account is archived. Reactivate it in Billing.', 'SUBSCRIPTION_ARCHIVED'));
  if (READ_ONLY.has(status) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next(new AppError(402, SUSPENDED_MESSAGE, 'SUBSCRIPTION_SUSPENDED'));
  }
  next();
}
