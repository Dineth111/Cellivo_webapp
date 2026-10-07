// TEMP: replace with Developer 4's service
import FakeStock from '../models/FakeStock.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest } from '../../../core/errors.js';
import { escapeRegex } from '../../../core/validate.js';

/**
 * Execute a stock query within the tenant context.
 */
async function withTenant(tenantId, fn) {
  return await runWithContext({ tenantId }, fn);
}

/**
 * Lookup product by barcode within a branch.
 */
export async function lookupByBarcode(tenantId, branchId, barcode) {
  return await withTenant(tenantId, async () => {
    return await FakeStock.findOne({ branchId, barcode });
  });
}

/**
 * Search products by name, brand, or barcode within a branch.
 */
export async function searchProducts(tenantId, branchId, query) {
  const text = String(query ?? '');
  if (text.length > 100) throw badRequest('Search text is too long (max 100 characters)', 'SEARCH_TOO_LONG');
  return await withTenant(tenantId, async () => {
    const reg = new RegExp(escapeRegex(text), 'i');
    return await FakeStock.find({
      branchId,
      $or: [{ name: reg }, { barcode: reg }, { brand: reg }],
    }).limit(50);
  });
}

/**
 * Lookup device by IMEI within a branch.
 */
export async function lookupImei(tenantId, branchId, imei) {
  return await withTenant(tenantId, async () => {
    const stock = await FakeStock.findOne({
      branchId,
      'imeiList.imei': imei,
    });
    if (!stock) return null;
    const item = stock.imeiList.find((i) => i.imei === imei);
    return { product: stock, imeiItem: item };
  });
}

/**
 * Reserve an IMEI for an active POS cart/session (default 15 minutes).
 */
export async function reserveImei(tenantId, branchId, imei, minutes = 15) {
  return await withTenant(tenantId, async () => {
    const stock = await FakeStock.findOne({ branchId, 'imeiList.imei': imei });
    if (!stock) throw badRequest(`IMEI ${imei} not found at this branch`);

    const item = stock.imeiList.find((i) => i.imei === imei);
    const now = new Date();
    if (item.status === 'sold') {
      throw badRequest(`IMEI ${imei} is already sold`);
    }
    if (item.status === 'reserved' && item.reservedUntil && item.reservedUntil > now) {
      throw badRequest(`IMEI ${imei} is already reserved by another transaction`);
    }

    item.status = 'reserved';
    item.reservedUntil = new Date(Date.now() + minutes * 60 * 1000);
    await stock.save();
    return { success: true, imei, reservedUntil: item.reservedUntil };
  });
}

/**
 * Release an IMEI reservation back to in_stock.
 */
export async function releaseImei(tenantId, branchId, imei) {
  return await withTenant(tenantId, async () => {
    const stock = await FakeStock.findOne({ branchId, 'imeiList.imei': imei });
    if (!stock) return { success: false };

    const item = stock.imeiList.find((i) => i.imei === imei);
    if (item && item.status === 'reserved') {
      item.status = 'in_stock';
      item.reservedUntil = null;
      await stock.save();
    }
    return { success: true, imei };
  });
}

/**
 * Deduct stock upon sale completion.
 * Throws code 'V-05' if insufficient stock.
 */
export async function deductStock(tenantId, branchId, barcodeOrImei, qty = 1, session = null) {
  return await withTenant(tenantId, async () => {
    // 1. Try finding by IMEI first
    let stock = await FakeStock.findOne({ branchId, 'imeiList.imei': barcodeOrImei }).session(session);
    if (stock) {
      const item = stock.imeiList.find((i) => i.imei === barcodeOrImei);
      if (!item || item.status === 'sold') {
        throw badRequest(`IMEI ${barcodeOrImei} is no longer available`, 'V-05');
      }
      item.status = 'sold';
      item.reservedUntil = null;
      stock.qty = Math.max(0, stock.qty - 1);
      await stock.save({ session });
      return { success: true, product: stock, deductedQty: 1, imei: barcodeOrImei };
    }

    // 2. Otherwise find by barcode
    stock = await FakeStock.findOne({ branchId, barcode: barcodeOrImei }).session(session);
    if (!stock) {
      throw badRequest(`Product with barcode ${barcodeOrImei} not found at this branch`, 'V-05');
    }

    if (stock.qty < qty) {
      throw badRequest(`Only ${stock.qty} left at this branch. Reduce the quantity or transfer stock.`, 'V-05');
    }

    stock.qty -= qty;
    await stock.save({ session });
    return { success: true, product: stock, deductedQty: qty };
  });
}

/**
 * Restock inventory upon a return or void.
 */
export async function restockReturn(tenantId, branchId, barcodeOrImei, qty = 1, session = null) {
  return await withTenant(tenantId, async () => {
    let stock = await FakeStock.findOne({ branchId, 'imeiList.imei': barcodeOrImei }).session(session);
    if (stock) {
      const item = stock.imeiList.find((i) => i.imei === barcodeOrImei);
      if (item) {
        item.status = 'in_stock';
        item.reservedUntil = null;
      }
      stock.qty += 1;
      await stock.save({ session });
      return { success: true, product: stock, restockedQty: 1 };
    }

    stock = await FakeStock.findOne({ branchId, barcode: barcodeOrImei }).session(session);
    if (stock) {
      stock.qty += qty;
      await stock.save({ session });
      return { success: true, product: stock, restockedQty: qty };
    }

    return { success: false, message: 'Item not found in stock to restock' };
  });
}

/**
 * Record a trade-in device into inventory.
 */
export async function addTradeIn(tenantId, branchId, tradeInData, session = null) {
  return await withTenant(tenantId, async () => {
    const { imei, modelName, valuationCents, condition, notes } = tradeInData;
    let stock = await FakeStock.findOne({ branchId, barcode: `TRADEIN-${imei || Date.now()}` }).session(session);
    if (!stock) {
      stock = new FakeStock({
        branchId,
        barcode: `TRADEIN-${imei || Date.now()}`,
        name: `Trade-in: ${modelName || 'Device'} (${condition || 'Used'})`,
        category: 'Trade-in',
        brand: tradeInData.brand || 'Unknown',
        sellingPriceCents: valuationCents,
        costPriceCents: valuationCents,
        qty: 1,
        imeiList: imei ? [{ imei, status: 'in_stock', reservedUntil: null }] : [],
      });
    } else {
      stock.qty += 1;
      if (imei) stock.imeiList.push({ imei, status: 'in_stock', reservedUntil: null });
    }
    await stock.save({ session });
    return stock;
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

    let stock = await FakeStock.findOne({ branchId, 'imeiList.imei': imeiOrBarcode }).session(session);
    if (stock) {
      if (stock.imeiList.find((i) => i.imei === imeiOrBarcode).status === 'sold') throw alreadySold();
      stock.imeiList = stock.imeiList.filter((i) => i.imei !== imeiOrBarcode);
    } else {
      stock = await FakeStock.findOne({ branchId, barcode: imeiOrBarcode }).session(session);
      if (!stock || stock.qty < 1) throw alreadySold();
    }
    stock.qty = Math.max(0, stock.qty - 1);
    await stock.save({ session });
    return { success: true, product: stock };
  });
}

/**
 * Get product cost in cents by barcode or IMEI.
 */
export async function getCost(tenantId, barcodeOrImei) {
  return await withTenant(tenantId, async () => {
    const stock = await FakeStock.findOne({
      $or: [{ barcode: barcodeOrImei }, { 'imeiList.imei': barcodeOrImei }],
    });
    return stock ? stock.costPriceCents : 0;
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
  getCost,
};
