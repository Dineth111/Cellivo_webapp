import mongoose from 'mongoose';
import Customer from '../../customers/Customer.model.js';
import LoyaltyTransaction from '../models/LoyaltyTransaction.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { getLoyaltySettings } from '../adapters/loyaltySettings.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';

/**
 * Calculates points earned on an actual paid amount in cents.
 * Strictly integer arithmetic: Math.floor(paidAmountCents / 10000) * pointsPerHundredRupees.
 */
export async function calculateEarnedPoints(tenantId, paidAmountCents) {
  const settings = await getLoyaltySettings(tenantId);
  const paidCents = Math.max(0, Math.round(Number(paidAmountCents || 0)));
  const hundreds = Math.floor(paidCents / 10000);
  return hundreds * (settings.pointsPerHundredRupees || 1);
}

/**
 * Validates whether a customer can redeem the requested points/amount.
 */
export async function validateRedemption(tenantId, customerId, pointsToRedeem, amountCents = null) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const cid = customerId instanceof mongoose.Types.ObjectId ? customerId : new mongoose.Types.ObjectId(String(customerId));

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findOne({ _id: cid, tenantId: tid });
    if (!customer) throw notFound('Customer not found');

    const settings = await getLoyaltySettings(tid);
    const requestedPoints = Math.round(Number(pointsToRedeem || 0));

    if (requestedPoints <= 0) {
      throw badRequest('Points to redeem must be greater than zero', 'INVALID_REDEMPTION_POINTS');
    }

    if ((customer.loyaltyPoints || 0) < settings.minRedemptionPoints) {
      throw badRequest(
        `Minimum ${settings.minRedemptionPoints} points required to redeem. Customer has ${customer.loyaltyPoints || 0} points.`,
        'MIN_POINTS_NOT_MET'
      );
    }

    if (requestedPoints > (customer.loyaltyPoints || 0)) {
      throw badRequest(
        `Insufficient points balance. Requested ${requestedPoints}, but customer only has ${customer.loyaltyPoints || 0} points.`,
        'INSUFFICIENT_POINTS'
      );
    }

    const calculatedValueCents = requestedPoints * (settings.valuePerPointCents || 100);

    if (amountCents != null) {
      const expectedAmountCents = Math.round(Number(amountCents));
      if (calculatedValueCents !== expectedAmountCents) {
        throw badRequest(
          `Redemption amount mismatch: ${requestedPoints} points equals ${calculatedValueCents} cents, but received ${expectedAmountCents} cents`,
          'REDEMPTION_AMOUNT_MISMATCH'
        );
      }
    }

    return {
      isValid: true,
      pointsToRedeem: requestedPoints,
      valueCents: calculatedValueCents,
      currentPoints: customer.loyaltyPoints || 0,
      balanceAfter: (customer.loyaltyPoints || 0) - requestedPoints,
    };
  });
}

/**
 * Accrues points for a paid amount (cash, card, split, or installment payment).
 * Strictly NO points on unpaid credit portion.
 */
export async function accruePoints({
  tenantId,
  branchId = null,
  customerId,
  invoiceId = null,
  paidAmountCents,
  type = 'earn', // 'earn' | 'installment_earn'
  session = null,
}) {
  if (!customerId) return null;
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const cid = customerId instanceof mongoose.Types.ObjectId ? customerId : new mongoose.Types.ObjectId(String(customerId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const points = await calculateEarnedPoints(tid, paidAmountCents);
  if (points <= 0) return null;

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findOne({ _id: cid, tenantId: tid }).session(session);
    if (!customer) return null;

    const previousPoints = customer.loyaltyPoints || 0;
    const newPoints = previousPoints + points;
    customer.loyaltyPoints = newPoints;
    await customer.save({ session });

    const tx = new LoyaltyTransaction({
      branchId: bid,
      customerId: cid,
      invoiceId,
      type,
      points,
      amountCents: Math.round(Number(paidAmountCents || 0)),
      balanceAfter: newPoints,
      date: new Date(),
    });

    await tx.save({ session });

    await auditAdapter.record({
      action: 'pos.loyalty_accrued',
      entity: 'Customer',
      entityId: customer._id,
      after: { pointsEarned: points, balanceAfter: newPoints, type },
      tenantId: tid,
    });

    return tx;
  });
}

/**
 * Redeems points as payment tender at checkout.
 */
export async function redeemPoints({
  tenantId,
  branchId = null,
  customerId,
  invoiceId = null,
  pointsToRedeem,
  amountCents,
  session = null,
}) {
  if (!customerId) {
    throw badRequest('Customer is required to redeem loyalty points', 'LOYALTY_REQUIRES_CUSTOMER');
  }

  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const cid = customerId instanceof mongoose.Types.ObjectId ? customerId : new mongoose.Types.ObjectId(String(customerId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const validation = await validateRedemption(tid, cid, pointsToRedeem, amountCents);

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findOne({ _id: cid, tenantId: tid }).session(session);
    if (!customer) throw notFound('Customer not found');

    const newPoints = (customer.loyaltyPoints || 0) - validation.pointsToRedeem;
    customer.loyaltyPoints = newPoints;
    await customer.save({ session });

    const tx = new LoyaltyTransaction({
      branchId: bid,
      customerId: cid,
      invoiceId,
      type: 'redeem',
      points: -validation.pointsToRedeem,
      amountCents: validation.valueCents,
      balanceAfter: newPoints,
      date: new Date(),
    });

    await tx.save({ session });

    await auditAdapter.record({
      action: 'pos.loyalty_redeemed',
      entity: 'Customer',
      entityId: customer._id,
      after: { pointsRedeemed: validation.pointsToRedeem, balanceAfter: newPoints },
      tenantId: tid,
    });

    return tx;
  });
}

/**
 * Reverses points originally earned on returned items.
 */
export async function reversePoints({
  tenantId,
  branchId = null,
  customerId,
  invoiceId = null,
  refundedAmountCents,
  session = null,
}) {
  if (!customerId) return null;

  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const cid = customerId instanceof mongoose.Types.ObjectId ? customerId : new mongoose.Types.ObjectId(String(customerId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const pointsToReverse = await calculateEarnedPoints(tid, refundedAmountCents);
  if (pointsToReverse <= 0) return null;

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findOne({ _id: cid, tenantId: tid }).session(session);
    if (!customer) return null;

    const previousPoints = customer.loyaltyPoints || 0;
    const newPoints = Math.max(0, previousPoints - pointsToReverse);
    customer.loyaltyPoints = newPoints;
    await customer.save({ session });

    const tx = new LoyaltyTransaction({
      branchId: bid,
      customerId: cid,
      invoiceId,
      type: 'return_reversal',
      points: -pointsToReverse,
      amountCents: Math.round(Number(refundedAmountCents || 0)),
      balanceAfter: newPoints,
      date: new Date(),
    });

    await tx.save({ session });

    await auditAdapter.record({
      action: 'pos.loyalty_reversed',
      entity: 'Customer',
      entityId: customer._id,
      after: { pointsReversed: pointsToReverse, balanceAfter: newPoints },
      tenantId: tid,
    });

    return tx;
  });
}

/**
 * Retrieves customer loyalty balance and transaction history.
 */
export async function getCustomerLoyaltyHistory(tenantId, customerId) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const cid = customerId instanceof mongoose.Types.ObjectId ? customerId : new mongoose.Types.ObjectId(String(customerId));

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findOne({ _id: cid, tenantId: tid });
    if (!customer) throw notFound('Customer not found');

    const history = await LoyaltyTransaction.find({ tenantId: tid, customerId: cid })
      .sort({ date: -1 })
      .lean();

    const settings = await getLoyaltySettings(tid);

    return {
      customerId: customer._id,
      customerName: customer.name,
      currentPoints: customer.loyaltyPoints || 0,
      pointsValueCents: (customer.loyaltyPoints || 0) * (settings.valuePerPointCents || 100),
      minRedemptionPoints: settings.minRedemptionPoints,
      valuePerPointCents: settings.valuePerPointCents,
      history,
    };
  });
}

export default {
  calculateEarnedPoints,
  validateRedemption,
  accruePoints,
  redeemPoints,
  reversePoints,
  getCustomerLoyaltyHistory,
};
