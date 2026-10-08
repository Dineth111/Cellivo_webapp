import mongoose from 'mongoose';
import SerialUnit from '../models/SerialUnit.model.js';
import Product from '../models/Product.model.js';
import Supplier from '../models/Supplier.model.js';
import StockMovement from '../models/StockMovement.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { escapeRegex } from '../../../core/validate.js';
import { isValidImei as luhnCheck } from '../../pos/utils/imei.js';

/**
 * Validate IMEI string (15 digits and Luhn checksum).
 */
export function validateImei(imei, fieldName = 'IMEI') {
  if (!imei) throw badRequest(`${fieldName} is required`);
  const cleaned = String(imei).trim();
  if (!/^\d{15}$/.test(cleaned)) {
    throw badRequest(`${fieldName} must be exactly 15 digits`);
  }
  if (!luhnCheck(cleaned)) {
    throw badRequest(`${fieldName} failed Luhn checksum validation`);
  }
  return cleaned;
}

/**
 * Allowed status state transitions.
 */
export const ALLOWED_TRANSITIONS = {
  in_stock: ['reserved', 'sold', 'in_transit', 'with_supplier', 'written_off', 'in_repair'],
  reserved: ['in_stock', 'sold'],
  sold: ['returned'],
  in_transit: ['in_stock'],
  returned: ['in_stock', 'written_off', 'with_supplier'],
  with_supplier: ['in_stock', 'written_off'],
  in_repair: ['in_stock', 'written_off'],
  written_off: [],
};

/**
 * Execute within tenant context.
 */
async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

/**
 * Check and execute a status transition for a serial unit in ONE place.
 */
export async function transitionStatus({
  tenantId,
  imei,
  newStatus,
  cartId = null,
  branchId = null,
  newBranchId = null,
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    const query = { $or: [{ imei1: imei }, { imei2: imei }] };
    if (branchId) query.branchId = branchId;

    const unit = await SerialUnit.findOne(query).session(session);
    if (!unit) {
      throw notFound(`IMEI ${imei} not found`);
    }

    const currentStatus = unit.status;
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];

    // Check transition validity
    if (!allowed.includes(newStatus) && currentStatus !== newStatus) {
      throw badRequest(`Cannot transition IMEI from '${currentStatus}' to '${newStatus}'`);
    }

    const now = new Date();

    // Specific rules for transition
    if (newStatus === 'reserved') {
      if (currentStatus === 'reserved' && unit.reservation?.reservedUntil > now && unit.reservation.cartId !== cartId) {
        throw badRequest(`IMEI ${imei} is already reserved by another transaction`);
      }
      unit.status = 'reserved';
      unit.reservation = {
        cartId: cartId || null,
        reservedUntil: new Date(Date.now() + 15 * 60 * 1000),
        reservedBy: userId || null,
      };
    } else if (newStatus === 'sold') {
      if (currentStatus === 'reserved' && unit.reservation?.reservedUntil > now) {
        if (cartId && unit.reservation.cartId && unit.reservation.cartId !== cartId) {
          throw badRequest(`IMEI ${imei} is reserved by another cart`);
        }
      }
      unit.status = 'sold';
      unit.reservation = { cartId: null, reservedUntil: null, reservedBy: null };
    } else if (newStatus === 'in_stock') {
      unit.status = 'in_stock';
      unit.reservation = { cartId: null, reservedUntil: null, reservedBy: null };
    } else {
      unit.status = newStatus;
      unit.reservation = { cartId: null, reservedUntil: null, reservedBy: null };
    }

    if (newBranchId) {
      unit.branchId = newBranchId;
    }

    await unit.save({ session });
    return unit;
  });
}

/**
 * Reserve an IMEI for an active POS cart/session (default 15 minutes).
 */
export async function reserveImei(tenantId, branchId, imei, cartId = null, minutes = 15, userId = null, session = null) {
  return await withTenant(tenantId, async () => {
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: imei }, { imei2: imei }],
    }).session(session);

    if (!unit) throw badRequest(`IMEI ${imei} not found at this branch`);
    if (unit.status === 'sold') throw badRequest(`IMEI ${imei} is already sold`);

    const now = new Date();
    if (unit.status === 'reserved' && unit.reservation?.reservedUntil > now) {
      if (cartId && unit.reservation.cartId && unit.reservation.cartId !== cartId) {
        throw badRequest(`IMEI ${imei} is already reserved by another transaction`);
      }
    }

    unit.status = 'reserved';
    unit.reservation = {
      cartId: cartId || null,
      reservedUntil: new Date(Date.now() + minutes * 60 * 1000),
      reservedBy: userId || null,
    };
    await unit.save({ session });
    return { success: true, imei, reservedUntil: unit.reservation.reservedUntil, cartId };
  });
}

/**
 * Release an IMEI reservation back to in_stock.
 */
export async function releaseImei(tenantId, branchId, imei, session = null) {
  return await withTenant(tenantId, async () => {
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: imei }, { imei2: imei }],
    }).session(session);

    if (!unit) return { success: false };

    if (unit.status === 'reserved') {
      unit.status = 'in_stock';
      unit.reservation = { cartId: null, reservedUntil: null, reservedBy: null };
      await unit.save({ session });
    }
    return { success: true, imei };
  });
}

/**
 * Lookup device by IMEI within a branch (compatible with POS contract).
 */
export async function lookupImei(tenantId, branchId, imei) {
  return await withTenant(tenantId, async () => {
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: imei }, { imei2: imei }],
    })
      .populate('productId')
      .populate('branchId', 'name')
      .lean();

    if (!unit || !unit.productId) return null;

    const product = unit.productId;
    return {
      product: {
        ...product,
        costPriceCents: unit.unitCostCents || product.costPriceCents,
      },
      imeiItem: {
        imei: unit.imei1,
        imei2: unit.imei2,
        status: unit.status,
        reservedUntil: unit.reservation?.reservedUntil || null,
        cartId: unit.reservation?.cartId || null,
      },
      serialUnit: unit,
    };
  });
}

/**
 * Search IMEI across branches or within a branch and return life timeline.
 */
export async function searchImei(tenantId, query, branchId = null) {
  const text = String(query ?? '').trim();
  if (!text) return [];
  if (text.length > 100) throw badRequest('Search text too long', 'SEARCH_TOO_LONG');

  return await withTenant(tenantId, async () => {
    const reg = new RegExp(escapeRegex(text), 'i');
    const filter = {
      $or: [{ imei1: reg }, { imei2: reg }, { serialNumber: reg }],
    };
    if (branchId) filter.branchId = branchId;

    const units = await SerialUnit.find(filter)
      .populate('productId', 'name barcode sku sellingPriceCents')
      .populate('branchId', 'name')
      .populate('supplierId', 'name')
      .limit(50)
      .lean();

    return units;
  });
}

/**
 * Get full life-history timeline for an IMEI.
 */
export async function getImeiTimeline(tenantId, imei) {
  return await withTenant(tenantId, async () => {
    const unit = await SerialUnit.findOne({
      $or: [{ imei1: imei }, { imei2: imei }],
    })
      .populate('productId')
      .populate('branchId', 'name')
      .populate('supplierId', 'name')
      .lean();

    if (!unit) throw notFound(`IMEI ${imei} not found`);

    const movements = await StockMovement.find({
      $or: [{ imei: unit.imei1 }, { imei: unit.imei2 }, { referenceId: unit.imei1 }],
    })
      .populate('branchId', 'name')
      .populate('userId', 'name')
      .sort({ createdAt: 1 })
      .lean();

    return {
      serialUnit: unit,
      movements,
    };
  });
}

export default {
  validateImei,
  transitionStatus,
  reserveImei,
  releaseImei,
  lookupImei,
  searchImei,
  getImeiTimeline,
};
