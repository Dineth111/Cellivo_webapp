import mongoose from 'mongoose';
import Product from '../models/Product.model.js';
import StockLevel from '../models/StockLevel.model.js';
import StockMovement from '../models/StockMovement.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { escapeRegex } from '../../../core/validate.js';
import { sendLowStockAlert } from '../adapters/notifications.adapter.js';

/**
 * Execute within tenant context.
 */
async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

/**
 * Atomically adjusts stock level and records a StockMovement.
 * Respects Mongo transactions via session.
 */
export async function adjustStockLevel({
  tenantId,
  productId,
  branchId,
  type,
  qtyChange,
  unitCostCents = 0,
  referenceType = '',
  referenceId = '',
  imei = '',
  note = '',
  userId = null,
  session = null,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const pid = productId instanceof mongoose.Types.ObjectId ? productId : new mongoose.Types.ObjectId(String(productId));
  const bid = branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId));
  const qty = Number(qtyChange);

  if (!qty || isNaN(qty)) {
    throw badRequest('Quantity change must be a non-zero number');
  }

  return await withTenant(tid, async () => {
    const product = await Product.findOne({ _id: pid }).session(session);
    if (!product) {
      throw notFound('Product not found');
    }

    let updatedLevel;
    let balanceAfter = 0;

    if (qty < 0) {
      const deduction = Math.abs(qty);
      // Atomic deduction: only matches if qty >= deduction
      updatedLevel = await StockLevel.findOneAndUpdate(
        { tenantId: tid, productId: pid, branchId: bid, qty: { $gte: deduction } },
        { $inc: { qty: -deduction } },
        { session, new: true }
      );

      if (!updatedLevel) {
        const current = await StockLevel.findOne({ tenantId: tid, productId: pid, branchId: bid }).session(session);
        const available = current ? current.qty : 0;
        throw badRequest(`Only ${available} left at this branch. Reduce the quantity or transfer stock.`, 'V-05');
      }
      balanceAfter = updatedLevel.qty;
    } else {
      // Quantity increase (restock, purchase, initial, return, etc.)
      const existing = await StockLevel.findOne({ tenantId: tid, productId: pid, branchId: bid }).session(session);
      const currentQty = existing ? existing.qty : 0;
      const currentAvgCost = existing ? existing.averageCostCents : 0;
      const effectiveUnitCost = unitCostCents > 0 ? unitCostCents : (existing?.averageCostCents || product.costPriceCents || 0);

      const totalQty = currentQty + qty;
      const newAvgCost = totalQty > 0
        ? Math.round((currentQty * currentAvgCost + qty * effectiveUnitCost) / totalQty)
        : effectiveUnitCost;

      updatedLevel = await StockLevel.findOneAndUpdate(
        { tenantId: tid, productId: pid, branchId: bid },
        { $inc: { qty }, $set: { averageCostCents: newAvgCost } },
        { session, new: true, upsert: true }
      );
      balanceAfter = updatedLevel.qty;
    }

    const totalCostCents = Math.abs(qty) * (unitCostCents || updatedLevel.averageCostCents || product.costPriceCents || 0);

    const movementDocs = await StockMovement.create(
      [
        {
          tenantId: tid,
          productId: pid,
          branchId: bid,
          type,
          qtyChange: qty,
          balanceAfter,
          unitCostCents: unitCostCents || updatedLevel.averageCostCents || product.costPriceCents || 0,
          totalCostCents,
          referenceType,
          referenceId,
          imei,
          note,
          userId,
        },
      ],
      { session }
    );

    // Low stock check - only send after transaction commits
    if (product.reorderLevel > 0 && balanceAfter <= product.reorderLevel && qty < 0) {
      const alertPayload = {
        tenantId: tid,
        branchId: bid,
        productId: pid,
        productName: product.name,
        currentQty: balanceAfter,
        reorderLevel: product.reorderLevel,
      };

      if (session && typeof session.inTransaction === 'function' && session.inTransaction()) {
        if (!session._postCommitCallbacks) {
          session._postCommitCallbacks = [];
          const origCommit = session.commitTransaction.bind(session);
          session.commitTransaction = async function (...args) {
            const result = await origCommit(...args);
            const callbacks = session._postCommitCallbacks || [];
            session._postCommitCallbacks = [];
            for (const cb of callbacks) {
              try {
                await cb();
              } catch (err) {
                console.error('[PostCommit Hook Error]', err);
              }
            }
            return result;
          };
        }
        session._postCommitCallbacks.push(() =>
          sendLowStockAlert(alertPayload).catch((err) => console.error('[LowStockAlert Error]', err))
        );
      } else {
        sendLowStockAlert(alertPayload).catch((err) => console.error('[LowStockAlert Error]', err));
      }
    }

    return {
      stockLevel: updatedLevel,
      movement: movementDocs[0],
    };
  });
}

/**
 * Get stock level for a product at a specific branch.
 */
export async function getStockLevel(tenantId, branchId, productId) {
  return await withTenant(tenantId, async () => {
    return await StockLevel.findOne({ branchId, productId }).lean();
  });
}

/**
 * Search products by barcode, SKU, name, or brand/model.
 */
export async function searchProducts(tenantId, branchId, query, limit = 50) {
  const text = String(query ?? '').trim();
  if (text.length > 100) {
    throw badRequest('Search text is too long (max 100 characters)', 'SEARCH_TOO_LONG');
  }

  return await withTenant(tenantId, async () => {
    const filter = { isArchived: false };
    if (text) {
      const reg = new RegExp(escapeRegex(text), 'i');
      filter.$or = [{ name: reg }, { barcode: reg }, { sku: reg }];
    }

    const products = await Product.find(filter)
      .populate('categoryId', 'name')
      .populate('brandId', 'name')
      .populate('modelId', 'name')
      .limit(Math.min(limit, 50))
      .lean();

    const productIds = products.map((p) => p._id);
    const stockLevels = await StockLevel.find({ branchId, productId: { $in: productIds } }).lean();
    const stockMap = new Map(stockLevels.map((sl) => [String(sl.productId), sl]));

    return products.map((p) => {
      const sl = stockMap.get(String(p._id));
      return {
        ...p,
        qty: sl ? sl.qty : 0,
        averageCostCents: sl ? sl.averageCostCents : p.costPriceCents,
      };
    });
  });
}

/**
 * Lookup product by barcode within a branch.
 */
export async function lookupProductByBarcode(tenantId, branchId, barcode) {
  return await withTenant(tenantId, async () => {
    const product = await Product.findOne({ barcode, isArchived: false })
      .populate('categoryId', 'name')
      .populate('brandId', 'name')
      .populate('modelId', 'name')
      .lean();

    if (!product) return null;

    const sl = await StockLevel.findOne({ branchId, productId: product._id }).lean();
    return {
      ...product,
      qty: sl ? sl.qty : 0,
      averageCostCents: sl ? sl.averageCostCents : product.costPriceCents,
    };
  });
}

export default {
  adjustStockLevel,
  getStockLevel,
  searchProducts,
  lookupProductByBarcode,
};
