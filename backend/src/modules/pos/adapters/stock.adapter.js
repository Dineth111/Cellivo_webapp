import mongoose from 'mongoose';
import Product from '../../inventory/models/Product.model.js';
import StockLevel from '../../inventory/models/StockLevel.model.js';
import SerialUnit from '../../inventory/models/SerialUnit.model.js';
import * as stockService from '../../inventory/services/stock.service.js';
import * as imeiService from '../../inventory/services/imei.service.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest } from '../../../core/errors.js';
import { escapeRegex } from '../../../core/validate.js';

/**
 * Execute a stock query within the tenant context.
 */
async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

/**
 * Helper to build product response enriched with branch stock & serials.
 */
async function formatProductWithStock(product, branchId, session = null) {
  if (!product) return null;
  const prodDoc = product.toObject ? product.toObject() : product;

  const stockLevel = await StockLevel.findOne({ branchId, productId: prodDoc._id }).session(session).lean();
  const serialUnits = await SerialUnit.find({
    branchId,
    productId: prodDoc._id,
    status: { $in: ['in_stock', 'reserved'] },
  }).session(session).lean();

  return {
    ...prodDoc,
    qty: stockLevel ? stockLevel.qty : 0,
    costPriceCents: stockLevel ? stockLevel.averageCostCents : (prodDoc.costPriceCents || 0),
    imeiList: serialUnits.map((su) => ({
      imei: su.imei1,
      imei2: su.imei2,
      status: su.status,
      reservedUntil: su.reservation?.reservedUntil || null,
      cartId: su.reservation?.cartId || null,
    })),
  };
}

/**
 * Lookup product by barcode within a branch.
 */
export async function lookupByBarcode(tenantId, branchId, barcode) {
  return await withTenant(tenantId, async () => {
    const product = await Product.findOne({ barcode, isArchived: false });
    if (!product) return null;
    return await formatProductWithStock(product, branchId);
  });
}

/**
 * Search products by name, brand, or barcode within a branch.
 */
export async function searchProducts(tenantId, branchId, query) {
  const text = String(query ?? '').trim();
  if (text.length > 100) throw badRequest('Search text is too long (max 100 characters)', 'SEARCH_TOO_LONG');

  return await withTenant(tenantId, async () => {
    const reg = new RegExp(escapeRegex(text), 'i');
    const products = await Product.find({
      isArchived: false,
      $or: [{ name: reg }, { barcode: reg }, { sku: reg }],
    })
      .limit(50)
      .lean();

    const productIds = products.map((p) => p._id);
    const [stockLevels, serialUnits] = await Promise.all([
      StockLevel.find({ branchId, productId: { $in: productIds } }).lean(),
      SerialUnit.find({
        branchId,
        productId: { $in: productIds },
        status: { $in: ['in_stock', 'reserved'] },
      }).lean(),
    ]);

    const stockMap = new Map(stockLevels.map((s) => [String(s.productId), s]));
    const serialMap = new Map();
    serialUnits.forEach((su) => {
      const pid = String(su.productId);
      if (!serialMap.has(pid)) serialMap.set(pid, []);
      serialMap.get(pid).push({
        imei: su.imei1,
        imei2: su.imei2,
        status: su.status,
        reservedUntil: su.reservation?.reservedUntil || null,
        cartId: su.reservation?.cartId || null,
      });
    });

    return products.map((p) => {
      const sl = stockMap.get(String(p._id));
      return {
        ...p,
        qty: sl ? sl.qty : 0,
        costPriceCents: sl ? sl.averageCostCents : p.costPriceCents,
        imeiList: serialMap.get(String(p._id)) || [],
      };
    });
  });
}

/**
 * Lookup device by IMEI within a branch.
 */
export async function lookupImei(tenantId, branchId, imei) {
  return await withTenant(tenantId, async () => {
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: imei }, { imei2: imei }],
    })
      .populate('productId')
      .lean();

    if (!unit || !unit.productId) return null;

    const product = unit.productId;
    const stockLevel = await StockLevel.findOne({ branchId, productId: product._id }).lean();

    return {
      product: {
        ...product,
        qty: stockLevel ? stockLevel.qty : 0,
        costPriceCents: unit.unitCostCents || stockLevel?.averageCostCents || product.costPriceCents,
      },
      imeiItem: {
        imei: unit.imei1,
        imei2: unit.imei2,
        status: unit.status,
        reservedUntil: unit.reservation?.reservedUntil || null,
        cartId: unit.reservation?.cartId || null,
      },
    };
  });
}

/**
 * Reserve an IMEI for an active POS cart/session (default 15 minutes).
 */
export async function reserveImei(tenantId, branchId, imei, minutes = 15, cartId = null) {
  return await withTenant(tenantId, async () => {
    return await imeiService.reserveImei(tenantId, branchId, imei, cartId, minutes);
  });
}

/**
 * Release an IMEI reservation back to in_stock.
 */
export async function releaseImei(tenantId, branchId, imei) {
  return await withTenant(tenantId, async () => {
    return await imeiService.releaseImei(tenantId, branchId, imei);
  });
}

/**
 * Deduct stock upon sale completion.
 * Throws code 'V-05' if insufficient stock or IMEI unavailable.
 */
export async function deductStock(tenantId, branchId, barcodeOrImei, qty = 1, session = null, cartId = null) {
  return await withTenant(tenantId, async () => {
    // 1. Try finding by IMEI first
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: barcodeOrImei }, { imei2: barcodeOrImei }],
    }).session(session);

    if (unit) {
      if (unit.status === 'reserved') {
        if (!cartId || unit.reservation?.cartId !== cartId) {
          throw badRequest(`IMEI ${barcodeOrImei} is reserved by another cart`, 'V-05');
        }
      } else if (unit.status !== 'in_stock') {
        throw badRequest(`IMEI ${barcodeOrImei} is not sellable (status: ${unit.status})`, 'V-05');
      }

      await imeiService.transitionStatus({
        tenantId,
        imei: barcodeOrImei,
        newStatus: 'sold',
        cartId,
        branchId,
        session,
      });

      const { stockLevel } = await stockService.adjustStockLevel({
        tenantId,
        productId: unit.productId,
        branchId,
        type: 'sale',
        qtyChange: -1,
        unitCostCents: unit.unitCostCents,
        referenceType: 'sale',
        imei: barcodeOrImei,
        session,
      });

      const product = await Product.findById(unit.productId).session(session).lean();
      return {
        success: true,
        product: { ...product, qty: stockLevel.qty, costPriceCents: unit.unitCostCents || stockLevel.averageCostCents },
        deductedQty: 1,
        imei: barcodeOrImei,
      };
    }

    // 2. Otherwise find by barcode
    const product = await Product.findOne({ barcode: barcodeOrImei, isArchived: false }).session(session);
    if (!product) {
      throw badRequest(`Product with barcode ${barcodeOrImei} not found at this branch`, 'V-05');
    }

    const { stockLevel } = await stockService.adjustStockLevel({
      tenantId,
      productId: product._id,
      branchId,
      type: 'sale',
      qtyChange: -qty,
      referenceType: 'sale',
      session,
    });

    return {
      success: true,
      product: { ...product.toObject(), qty: stockLevel.qty, costPriceCents: stockLevel.averageCostCents },
      deductedQty: qty,
    };
  });
}

/**
 * Restock inventory upon a return or void.
 */
export async function restockReturn(tenantId, branchId, barcodeOrImei, qty = 1, session = null, condition = 'Resellable') {
  return await withTenant(tenantId, async () => {
    const cond = String(condition || 'Resellable').toLowerCase().replace(/\s+/g, '_');
    let targetStatus = 'in_stock';
    if (cond === 'damaged') targetStatus = 'written_off';
    else if (cond === 'to_supplier') targetStatus = 'with_supplier';

    // Try IMEI first
    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: barcodeOrImei }, { imei2: barcodeOrImei }],
    }).session(session);

    if (unit) {
      await imeiService.transitionStatus({
        tenantId,
        imei: barcodeOrImei,
        newStatus: targetStatus,
        branchId,
        session,
      });

      if (targetStatus === 'in_stock') {
        const { stockLevel } = await stockService.adjustStockLevel({
          tenantId,
          productId: unit.productId,
          branchId,
          type: 'sale_return',
          qtyChange: 1,
          unitCostCents: unit.unitCostCents,
          referenceType: 'return',
          imei: barcodeOrImei,
          session,
        });

        const product = await Product.findById(unit.productId).session(session).lean();
        return {
          success: true,
          product: { ...product, qty: stockLevel.qty, costPriceCents: unit.unitCostCents || stockLevel.averageCostCents },
          restockedQty: 1,
        };
      }

      const product = await Product.findById(unit.productId).session(session).lean();
      const stockLevel = await StockLevel.findOne({ branchId, productId: unit.productId }).session(session).lean();
      return {
        success: true,
        product: { ...product, qty: stockLevel?.qty || 0, costPriceCents: unit.unitCostCents || product?.costPriceCents || 0 },
        restockedQty: 0,
      };
    }

    // Otherwise barcode
    if (targetStatus === 'in_stock') {
      const product = await Product.findOne({ barcode: barcodeOrImei, isArchived: false }).session(session);
      if (product) {
        const { stockLevel } = await stockService.adjustStockLevel({
          tenantId,
          productId: product._id,
          branchId,
          type: 'sale_return',
          qtyChange: qty,
          referenceType: 'return',
          session,
        });

        return {
          success: true,
          product: { ...product.toObject(), qty: stockLevel.qty, costPriceCents: stockLevel.averageCostCents },
          restockedQty: qty,
        };
      }
    }

    return { success: false, message: 'Item not found in stock to restock' };
  });
}

/**
 * Record a trade-in device into inventory.
 */
export async function addTradeIn(tenantId, branchId, tradeInData, session = null) {
  return await withTenant(tenantId, async () => {
    const { imei, modelName, valuationCents, condition, brand, notes } = tradeInData;
    const barcode = `TRADEIN-${imei || Date.now()}`;

    let product = await Product.findOne({ barcode }).session(session);
    if (!product) {
      const createdProds = await Product.create(
        [
          {
            name: `Trade-in: ${modelName || 'Device'} (${condition || 'Used'})`,
            barcode,
            sellingPriceCents: valuationCents,
            costPriceCents: valuationCents,
            isSerialised: !!imei,
            description: notes || '',
          },
        ],
        { session }
      );
      product = createdProds[0];
    }

    if (imei) {
      let unit = await SerialUnit.findOne({ imei1: imei }).session(session);
      if (!unit) {
        await SerialUnit.create(
          [
            {
              imei1: imei,
              productId: product._id,
              branchId,
              unitCostCents: valuationCents,
              status: 'in_stock',
            },
          ],
          { session }
        );
      } else {
        if (unit.status !== 'in_stock') {
          await imeiService.transitionStatus({
            tenantId,
            imei,
            newStatus: 'in_stock',
            newBranchId: branchId,
            session,
          });
        } else if (String(unit.branchId) !== String(branchId)) {
          unit.branchId = branchId;
          await unit.save({ session });
        }
      }
    }

    const { stockLevel } = await stockService.adjustStockLevel({
      tenantId,
      productId: product._id,
      branchId,
      type: 'trade_in',
      qtyChange: 1,
      unitCostCents: valuationCents,
      referenceType: 'trade_in',
      imei: imei || '',
      session,
    });

    return {
      _id: product._id,
      barcode: product.barcode,
      name: product.name,
      sellingPriceCents: product.sellingPriceCents,
      costPriceCents: product.costPriceCents,
      qty: stockLevel.qty,
      imeiList: imei ? [{ imei, status: 'in_stock' }] : [],
    };
  });
}

/**
 * Takes a traded-in unit back out of stock (void of the trade-in sale).
 * Refuses with CANNOT_VOID_TRADEIN_SOLD if the unit was already sold on.
 */
export async function removeTradeIn(tenantId, branchId, imeiOrBarcode, session = null) {
  return await withTenant(tenantId, async () => {
    const alreadySold = () =>
      badRequest(`Traded-in device ${imeiOrBarcode} was already sold. Process a return instead of a void.`, 'CANNOT_VOID_TRADEIN_SOLD');

    const unit = await SerialUnit.findOne({
      branchId,
      $or: [{ imei1: imeiOrBarcode }, { imei2: imeiOrBarcode }],
    }).session(session);

    if (unit) {
      if (unit.status === 'sold') throw alreadySold();
      await imeiService.transitionStatus({
        tenantId,
        imei: unit.imei1 || imeiOrBarcode,
        newStatus: 'written_off',
        branchId,
        reason: 'Trade-in void',
        session,
      });
      const product = await Product.findById(unit.productId).session(session).lean();
      return { success: true, product };
    }

    const product = await Product.findOne({ barcode: imeiOrBarcode }).session(session);
    if (!product) throw alreadySold();

    const stockLevel = await StockLevel.findOne({ branchId, productId: product._id }).session(session);
    if (!stockLevel || stockLevel.qty < 1) throw alreadySold();

    await stockService.adjustStockLevel({
      tenantId,
      productId: product._id,
      branchId,
      type: 'trade_in_void',
      qtyChange: -1,
      session,
    });

    return { success: true, product: product.toObject() };
  });
}

export default {
  lookupByBarcode,
  searchProducts,
  lookupImei,
  reserveImei,
  releaseImei,
  deductStock,
  restockReturn,
  addTradeIn,
  removeTradeIn,
};
