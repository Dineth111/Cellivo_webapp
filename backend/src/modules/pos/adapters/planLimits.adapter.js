// TEMP: replace with Developer 2's service
import {
  hasFeature as baseHasFeature,
  planOf,
  requireFeature,
  subscriptionGuard,
  tenantFromContext,
} from '../../plans/planLimits.js';

/**
 * Checks whether a tenant (or plan) has a given feature enabled.
 *
 * @param {object} tenantOrPlan
 * @param {string} feature
 * @returns {Promise<boolean>}
 */
export async function hasFeature(tenantOrPlan, feature) {
  if (!tenantOrPlan) return false;
  const plan = tenantOrPlan.features ? tenantOrPlan : await planOf(tenantOrPlan);
  return baseHasFeature(plan, feature);
}

export { requireFeature, subscriptionGuard, tenantFromContext };

export default {
  hasFeature,
  requireFeature,
  subscriptionGuard,
  tenantFromContext,
};
