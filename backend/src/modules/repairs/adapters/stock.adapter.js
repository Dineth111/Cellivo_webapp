import mongoose from 'mongoose';
import * as stockService from '../../inventory/services/stock.service.js';
import Product from '../../inventory/models/Product.model.js';
import StockLevel from '../../inventory/models/StockLevel.model.js';
import { badRequest, notFound, forbidden } from '../../../core/errors.js';

/**
 * Validates and reserves a part for a repair ticket.
 * - If productId is provided, checks inventory, gets average cost from StockLevel,
 *   atomically deducts stock using stockService.adjustStockLevel within the caller's session,
 *   and records StockMovement referencing the ticket.
 * - If productId is not provided, validates free-text part data without touching stock.
 */
export async function reservePart({
  tenantId,
  branchId,
  ticketNo,
  productId = null,
  name = null,
  sku = null,
  qty = 1,
  unitCostCents = 0,
  unitPriceCents = null,
  serial = null,
  addedBy = null,
  session = null,
}) {
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
    throw badRequest('Part quantity must be an integer between 1 and 1000', 'INVALID_PART_QTY');
  }

  // 1. Inventory-managed part
  if (productId) {
    if (!tenantId || !branchId) {
      throw badRequest('tenantId and branchId are required for inventory-managed parts');
    }
    const pid = productId instanceof mongoose.Types.ObjectId ? productId : new mongoose.Types.ObjectId(String(productId));

    const product = await Product.findOne({ _id: pid, tenantId, isArchived: false }).session(session);
    if (!product) {
      throw notFound('Product not found');
    }

    // Cost is determined from the inventory stock level (or product cost fallback), never from user input
    const stockLevel = await StockLevel.findOne({ tenantId, branchId, productId: pid }).session(session);
    const effectiveCost = stockLevel?.averageCostCents ?? product.costPriceCents ?? 0;

    // Price defaults from product's selling price if not explicitly provided
    let effectivePrice = unitPriceCents;
    if (effectivePrice === null || effectivePrice === undefined) {
      effectivePrice = product.sellingPriceCents || 0;
    }
    if (!Number.isInteger(effectivePrice) || effectivePrice < 0 || effectivePrice > 100_000_000) {
      throw badRequest('Part unit price must be an integer between 0 and 100,000,000 cents', 'INVALID_PART_PRICE');
    }

    // Atomically decrement stock level and record StockMovement referencing the ticket
    await stockService.adjustStockLevel({
      tenantId,
      productId: pid,
      branchId,
      type: 'adjustment_loss',
      qtyChange: -qty,
      unitCostCents: effectiveCost,
      referenceType: 'repair',
      referenceId: ticketNo,
      note: `Repair part used on ${ticketNo}`,
      userId: addedBy,
      session,
    });

    return {
      productId: product._id,
      inventoryManaged: true,
      name: product.name,
      sku: product.sku || sku || null,
      qty,
      unitCostCents: effectiveCost,
      unitPriceCents: effectivePrice,
      serial: serial ? String(serial).trim() : null,
      addedAt: new Date(),
      addedBy,
    };
  }

  // 2. Free-text part (off-book)
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw badRequest('Part name is required');
  }
  const trimmedName = name.trim();
  if (trimmedName.length > 100) {
    throw badRequest('Part name must be at most 100 characters');
  }
  const cost = unitCostCents !== undefined && unitCostCents !== null ? unitCostCents : 0;
  if (!Number.isInteger(cost) || cost < 0 || cost > 100_000_000) {
    throw badRequest('Part unit cost must be an integer between 0 and 100,000,000 cents', 'INVALID_PART_COST');
  }
  const price = unitPriceCents !== undefined && unitPriceCents !== null ? unitPriceCents : 0;
  if (!Number.isInteger(price) || price < 0 || price > 100_000_000) {
    throw badRequest('Part unit price must be an integer between 0 and 100,000,000 cents', 'INVALID_PART_PRICE');
  }

  return {
    productId: null,
    inventoryManaged: false,
    name: trimmedName,
    sku: sku ? String(sku).trim() : null,
    qty,
    unitCostCents: cost,
    unitPriceCents: price,
    serial: serial ? String(serial).trim() : null,
    addedAt: new Date(),
    addedBy,
  };
}

/**
 * Consumes a part (backwards-compatible hook).
 */
export async function consumePart({ ticket, partId }) {
  const part = ticket.parts.id(partId);
  if (!part) throw badRequest('Part not found on ticket');
  return { success: true, part };
}

/**
 * Releases a part from the ticket and restores inventory stock if it was inventory-managed.
 */
export async function releasePart({ tenantId, branchId, ticketNo, part, userId = null, session = null }) {
  if (!part) throw badRequest('Part is required to release');

  if (part.inventoryManaged && part.productId) {
    await stockService.adjustStockLevel({
      tenantId,
      productId: part.productId,
      branchId,
      type: 'adjustment_gain',
      qtyChange: part.qty,
      unitCostCents: part.unitCostCents || 0,
      referenceType: 'repair',
      referenceId: ticketNo,
      note: `Repair part returned from ${ticketNo}`,
      userId,
      session,
    });
  }

  return { success: true };
}

export default {
  reservePart,
  consumePart,
  releasePart,
};
