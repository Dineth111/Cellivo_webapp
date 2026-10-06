// TEMP: replace with Developer 5's service
/**
 * Loyalty Settings Adapter for POS integration.
 * Default settings:
 * - 1 point per 100 LKR (10,000 cents paid)
 * - 1 point = 100 cents (1 LKR value)
 * - Minimum 100 points required to redeem
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @returns {Promise<{ pointsPerHundredRupees: number, valuePerPointCents: number, minRedemptionPoints: number }>}
 */
export async function getLoyaltySettings(tenantId) {
  return {
    pointsPerHundredRupees: 1, // 1 point per 10,000 cents
    valuePerPointCents: 100,   // 1 point = 100 cents (1 LKR)
    minRedemptionPoints: 100,  // Minimum 100 points
  };
}

export default { getLoyaltySettings };
