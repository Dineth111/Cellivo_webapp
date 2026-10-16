import LoyaltySettings from '../../customers/LoyaltySettings.model.js';
import { runWithContext } from '../../../core/tenantContext.js';

export const DEFAULT_LOYALTY_SETTINGS = {
  pointsPerHundredRupees: 1, // 1 point per 10,000 cents
  valuePerPointCents: 100,   // 1 point = 100 cents (1 LKR)
  minRedemptionPoints: 100,  // Minimum 100 points
  expiryDays: 365,
};

/**
 * Loyalty Settings Adapter for POS integration.
 * Reads tenant LoyaltySettings or returns safe defaults.
 * Wrapped in runWithContext({ tenantId }) because callers (e.g. calculateEarnedPoints)
 * may call it with no tenant context.
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @returns {Promise<{ pointsPerHundredRupees: number, valuePerPointCents: number, minRedemptionPoints: number, expiryDays?: number }>}
 */
export async function getLoyaltySettings(tenantId) {
  if (!tenantId) return { ...DEFAULT_LOYALTY_SETTINGS };

  try {
    const settings = await runWithContext({ tenantId }, async () => {
      return await LoyaltySettings.findOne().lean();
    });

    if (!settings) return { ...DEFAULT_LOYALTY_SETTINGS };

    return {
      pointsPerHundredRupees: settings.pointsPerHundredRupees ?? DEFAULT_LOYALTY_SETTINGS.pointsPerHundredRupees,
      valuePerPointCents: settings.valuePerPointCents ?? DEFAULT_LOYALTY_SETTINGS.valuePerPointCents,
      minRedemptionPoints: settings.minRedemptionPoints ?? DEFAULT_LOYALTY_SETTINGS.minRedemptionPoints,
      expiryDays: settings.expiryDays ?? DEFAULT_LOYALTY_SETTINGS.expiryDays,
    };
  } catch (err) {
    console.error('[getLoyaltySettings]', err);
    return { ...DEFAULT_LOYALTY_SETTINGS };
  }
}

export default { getLoyaltySettings, DEFAULT_LOYALTY_SETTINGS };
