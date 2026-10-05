import { Coupon, Invoice } from './billing.models.js';
import { badRequest } from '../../core/errors.js';

/**
 * Validate a coupon for a purchase and compute its discount in minor units (FRS F-02, A-07).
 * Expired, inactive, exhausted, over the per-shop limit or not eligible for the plan/term: 400.
 */
export async function applyCoupon(code, { planCode, term, currency, priceMinor, tenantId }, now = new Date()) {
  const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() });
  const invalid = (why = 'This coupon code is not valid') => badRequest(why, 'COUPON_INVALID');
  if (!coupon || !coupon.active) throw invalid();
  if ((coupon.validFrom && coupon.validFrom > now) || (coupon.validTo && coupon.validTo < now)) throw invalid('This coupon has expired');
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) throw invalid('This coupon has reached its usage limit');
  if (coupon.plans.length && !coupon.plans.includes(planCode)) throw invalid('This coupon is not valid for the selected plan');
  if (coupon.terms.length && !coupon.terms.includes(term)) throw invalid('This coupon is not valid for the selected billing term');
  if (tenantId && (await Invoice.countDocuments({ tenantId, couponCode: coupon.code, status: { $ne: 'void' } })) >= coupon.perTenantLimit) {
    throw invalid('You have already used this coupon');
  }
  const off = coupon.type === 'percent' ? Math.round((priceMinor * coupon.percent) / 100) : Math.round((coupon.fixed[currency] ?? 0) * 100);
  return { coupon, discount: Math.min(off, priceMinor) };
}

export const redeemCoupon = (coupon) => Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: 1 } });
