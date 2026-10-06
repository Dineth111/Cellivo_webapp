// TEMP: replace with Developer 5's service

/**
 * Returns tenant loyalty settings with standard defaults.
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @returns {Promise<{ isEnabled: boolean, earnRatePercent: number, redeemRateCents: number, minRedeemPoints: number, pointValueCents: number }>}
 */
export async function getLoyaltySettings(tenantId) {
  return {
    isEnabled: true,
    earnRatePercent: 1, // 1 point earned per 100 LKR spent
    redeemRateCents: 100, // 1 point = 100 cents (1 LKR)
    minRedeemPoints: 100, // minimum 100 points required to redeem
    pointValueCents: 100,
  };
}

export default { getLoyaltySettings };
