import mongoose from 'mongoose';
import StockAdjustment, { ADJUSTMENT_REASONS } from '../models/StockAdjustment.model.js';
import StockCount from '../models/StockCount.model.js';
import Product from '../models/Product.model.js';
import StockLevel from '../models/StockLevel.model.js';
import SerialUnit from '../models/SerialUnit.model.js';
import Category from '../models/Category.model.js';
import Brand from '../models/Brand.model.js';
import ProductModel from '../models/ProductModel.model.js';
import * as stockService from '../services/stock.service.js';
import * as imeiService from '../services/imei.service.js';
import * as ledgerService from '../../pos/services/ledger.service.js';
import { str, requireId, pageParams } from '../../../core/validate.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { record as recordAudit } from '../../../core/audit.js';
import { maskCost } from '../utils/maskCost.js';
import { resolveBranch } from '../../pos/utils/branch.js';

function generateNumber(prefix = 'ADJ') {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${d}-${rnd}`;
}

// ==========================================
// STOCK ADJUSTMENTS
// ==========================================

export async function createAdjustment(req, res) {
  const branch = await resolveBranch(req);
  const productId = requireId(req.body.productId, 'productId');
  const adjustmentType = str(req.body.adjustmentType);
  const reason = str(req.body.reason);
  const qty = Number(req.body.qty);
  const imei = str(req.body.imei);
  const notes = str(req.body.notes) || '';

  if (!['increase', 'decrease'].includes(adjustmentType)) {
    throw badRequest("adjustmentType must be 'increase' or 'decrease'");
  }
  if (!ADJUSTMENT_REASONS.includes(reason)) {
    throw badRequest(`reason must be one of: ${ADJUSTMENT_REASONS.join(', ')}`);
  }
  if (!qty || qty <= 0 || isNaN(qty)) {
    throw badRequest('Quantity must be a positive number');
  }

  const tid = req.auth.tenantId;
  const adjustmentNumber = generateNumber('ADJ');
  const qtyChange = adjustmentType === 'increase' ? qty : -qty;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const product = await Product.findOne({ _id: productId, isArchived: false }).session(session);
    if (!product) throw notFound('Product not found');

    if (product.isSerialised && !imei && qty === 1) {
      // Serialised item adjustment should provide IMEI if 1 unit
    }

    if (imei) {
      if (adjustmentType === 'decrease') {
        await imeiService.transitionStatus({
          tenantId: tid,
          imei,
          newStatus: 'written_off',
          branchId: branch._id,
          reason: `${reason}: ${notes}`,
          userId: req.auth.userId,
          session,
        });
      } else {
        const unit = await SerialUnit.findOne({ imei1: imei }).session(session);
        if (unit) {
          await imeiService.transitionStatus({
            tenantId: tid,
            imei,
            newStatus: 'in_stock',
            branchId: branch._id,
            reason: `${reason}: ${notes}`,
            userId: req.auth.userId,
            session,
          });
        } else {
          await SerialUnit.create(
            [
              {
                imei1: imei,
                productId,
                branchId: branch._id,
                unitCostCents: product.costPriceCents,
                status: 'in_stock',
                notes: `Found adjustment: ${notes}`,
              },
            ],
            { session }
          );

          await stockService.adjustStockLevel({
            tenantId: tid,
            productId,
            branchId: branch._id,
            type: 'adjustment_gain',
            qtyChange: 1,
            unitCostCents: product.costPriceCents,
            referenceType: 'adjustment',
            referenceId: adjustmentNumber,
            imei,
            note: `${reason}: ${notes}`,
            userId: req.auth.userId,
            session,
          });

          if (product.costPriceCents > 0) {
            await ledgerService.postJournal({
              tenantId: tid,
              branchId: branch._id,
              referenceType: 'stock_adjustment',
              referenceId: adjustmentNumber,
              description: `Stock adjustment gain ${adjustmentNumber} (${reason})`,
              lines: [
                { accountCode: '1050', debit: product.costPriceCents, credit: 0 },
                { accountCode: '5040', debit: 0, credit: product.costPriceCents },
              ],
              createdBy: req.auth.userId,
              session,
            });
          }
        }
      }
    } else {
      await stockService.adjustStockLevel({
        tenantId: tid,
        productId,
        branchId: branch._id,
        type: adjustmentType === 'increase' ? 'adjustment_gain' : 'adjustment_loss',
        qtyChange,
        unitCostCents: product.costPriceCents,
        referenceType: 'adjustment',
        referenceId: adjustmentNumber,
        imei: '',
        note: `${reason}: ${notes}`,
        userId: req.auth.userId,
        session,
      });

      const totalCost = qty * (product.costPriceCents || 0);
      if (totalCost > 0) {
        if (adjustmentType === 'decrease') {
          await ledgerService.postJournal({
            tenantId: tid,
            branchId: branch._id,
            referenceType: 'stock_adjustment',
            referenceId: adjustmentNumber,
            description: `Stock adjustment loss ${adjustmentNumber} (${reason})`,
            lines: [
              { accountCode: '5040', debit: totalCost, credit: 0 },
              { accountCode: '1050', debit: 0, credit: totalCost },
            ],
            createdBy: req.auth.userId,
            session,
          });
        } else {
          await ledgerService.postJournal({
            tenantId: tid,
            branchId: branch._id,
            referenceType: 'stock_adjustment',
            referenceId: adjustmentNumber,
            description: `Stock adjustment gain ${adjustmentNumber} (${reason})`,
            lines: [
              { accountCode: '1050', debit: totalCost, credit: 0 },
              { accountCode: '5040', debit: 0, credit: totalCost },
            ],
            createdBy: req.auth.userId,
            session,
          });
        }
      }
    }

    const adjustmentDocs = await StockAdjustment.create(
      [
        {
          branchId: branch._id,
          productId,
          adjustmentNumber,
          adjustmentType,
          qtyChange,
          reason,
          unitCostCents: product.costPriceCents,
          totalCostCents: qty * product.costPriceCents,
          imei: imei || null,
          notes,
          status: 'approved',
          userId: req.auth.userId,
          approvedBy: req.auth.userId,
          approvedAt: new Date(),
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    await recordAudit({
      action: 'inventory.stock_adjusted',
      entity: 'StockAdjustment',
      entityId: adjustmentDocs[0]._id,
      after: adjustmentDocs[0].toObject(),
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });

    res.status(201).json({ success: true, data: maskCost(adjustmentDocs[0], req.auth.role) });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

export async function listAdjustments(req, res) {
  const { page, limit, skip } = pageParams(req.query, 100);
  const branch = await resolveBranch(req, { allowAll: true });

  const filter = {};
  if (branch) filter.branchId = branch._id;
  if (req.query.productId) filter.productId = requireId(req.query.productId);
  if (req.query.reason) filter.reason = str(req.query.reason);

  const [total, adjustments] = await Promise.all([
    StockAdjustment.countDocuments(filter),
    StockAdjustment.find(filter)
      .populate('productId', 'name barcode')
      .populate('branchId', 'name')
      .populate('userId', 'name')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json({
    success: true,
    total,
    page,
    limit,
    data: maskCost(adjustments, req.auth.role),
  });
}

// ==========================================
// STOCK COUNT (AUDIT)
// ==========================================

export async function createStockCount(req, res) {
  const branch = await resolveBranch(req);
  const notes = str(req.body.notes) || '';
  const countNumber = generateNumber('STC');

  // Load all products and current stock levels at this branch
  const products = await Product.find({ isArchived: false }).lean();
  const stockLevels = await StockLevel.find({ branchId: branch._id }).lean();
  const stockMap = new Map(stockLevels.map((sl) => [String(sl.productId), sl.qty]));

  const items = products.map((p) => {
    const expectedQty = stockMap.get(String(p._id)) || 0;
    return {
      productId: p._id,
      productName: p.name,
      barcode: p.barcode,
      expectedQty,
      countedQty: expectedQty, // default counted = expected until updated
      varianceQty: 0,
      unitCostCents: p.costPriceCents,
      varianceCostCents: 0,
      scannedImeis: [],
    };
  });

  const count = await StockCount.create({
    branchId: branch._id,
    countNumber,
    status: 'in_progress',
    items,
    notes,
    startedBy: req.auth.userId,
  });

  res.status(201).json({ success: true, data: maskCost(count, req.auth.role) });
}

export async function updateStockCount(req, res) {
  const id = requireId(req.params.id);
  const count = await StockCount.findById(id);
  if (!count) throw notFound('Stock count not found');
  if (['approved', 'cancelled'].includes(count.status)) {
    throw badRequest(`Cannot update stock count in '${count.status}' status`);
  }

  const countedItems = req.body.items;
  if (Array.isArray(countedItems)) {
    const inputMap = new Map(countedItems.map((ci) => [String(ci.productId), ci]));

    let totalVarianceQty = 0;
    let totalVarianceCostCents = 0;

    count.items.forEach((item) => {
      const input = inputMap.get(String(item.productId));
      if (input) {
        if (input.countedQty !== undefined) {
          item.countedQty = Math.max(0, Number(input.countedQty) || 0);
          item.varianceQty = item.countedQty - item.expectedQty;
          item.varianceCostCents = item.varianceQty * item.unitCostCents;
        }
        if (Array.isArray(input.scannedImeis)) {
          item.scannedImeis = input.scannedImeis;
          item.countedQty = input.scannedImeis.length;
          item.varianceQty = item.countedQty - item.expectedQty;
          item.varianceCostCents = item.varianceQty * item.unitCostCents;
        }
      }
      totalVarianceQty += item.varianceQty;
      totalVarianceCostCents += item.varianceCostCents;
    });

    count.totalVarianceQty = totalVarianceQty;
    count.totalVarianceCostCents = totalVarianceCostCents;
  }

  if (req.body.notes !== undefined) count.notes = str(req.body.notes) || '';
  if (req.body.status && ['draft', 'in_progress', 'completed'].includes(req.body.status)) {
    count.status = req.body.status;
  }

  await count.save();
  res.json({ success: true, data: maskCost(count, req.auth.role) });
}

export async function approveStockCount(req, res) {
  const id = requireId(req.params.id);
  const count = await StockCount.findById(id);
  if (!count) throw notFound('Stock count not found');
  if (count.status === 'approved') throw badRequest('Stock count is already approved');
  if (count.status === 'cancelled') throw badRequest('Cannot approve a cancelled stock count');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let totalVarianceQty = 0;
    let totalVarianceCostCents = 0;

    for (const item of count.items) {
      const product = await Product.findById(item.productId).session(session);
      const currentLevel = await StockLevel.findOne({ branchId: count.branchId, productId: item.productId }).session(session);
      const currentQty = currentLevel ? currentLevel.qty : 0;

      // Recompute variance against CURRENT StockLevel.qty
      item.expectedQty = currentQty;
      item.varianceQty = item.countedQty - currentQty;
      item.varianceCostCents = item.varianceQty * item.unitCostCents;
      totalVarianceQty += item.varianceQty;
      totalVarianceCostCents += item.varianceCostCents;

      if (product?.isSerialised) {
        // Serialised product: compare scanned IMEIs with in_stock serial units
        const inStockUnits = await SerialUnit.find({
          branchId: count.branchId,
          productId: item.productId,
          status: 'in_stock',
        }).session(session);

        const inStockMap = new Map(inStockUnits.map((u) => [u.imei1, u]));
        const scannedSet = new Set(item.scannedImeis || []);

        // 1. Missing units: in_stock but not scanned -> written_off via transitionStatus
        for (const [imei, unit] of inStockMap) {
          if (!scannedSet.has(imei)) {
            await imeiService.transitionStatus({
              tenantId: req.auth.tenantId,
              imei,
              newStatus: 'written_off',
              branchId: count.branchId,
              reason: `Stock count missing: ${count.countNumber}`,
              userId: req.auth.userId,
              session,
            });
          }
        }

        // 2. Unknown scanned IMEIs: scanned but not in_stock -> reported, not created
        const unknownImeis = [];
        for (const scanned of (item.scannedImeis || [])) {
          if (!inStockMap.has(scanned)) {
            unknownImeis.push(scanned);
          }
        }
        item.unknownImeis = unknownImeis;
      } else {
        // Non-serialised product adjustment
        if (item.varianceQty !== 0) {
          const type = item.varianceQty > 0 ? 'adjustment_gain' : 'adjustment_loss';
          await stockService.adjustStockLevel({
            tenantId: req.auth.tenantId,
            productId: item.productId,
            branchId: count.branchId,
            type,
            qtyChange: item.varianceQty,
            unitCostCents: item.unitCostCents,
            referenceType: 'stock_count',
            referenceId: count.countNumber,
            note: `Stock count approval: ${count.countNumber}`,
            userId: req.auth.userId,
            session,
          });

          const cost = Math.abs(item.varianceQty) * item.unitCostCents;
          if (cost > 0) {
            if (item.varianceQty < 0) {
              await ledgerService.postJournal({
                tenantId: req.auth.tenantId,
                branchId: count.branchId,
                referenceType: 'stock_adjustment',
                referenceId: count.countNumber,
                description: `Stock count loss ${count.countNumber}`,
                lines: [
                  { accountCode: '5040', debit: cost, credit: 0 },
                  { accountCode: '1050', debit: 0, credit: cost },
                ],
                createdBy: req.auth.userId,
                session,
              });
            } else {
              await ledgerService.postJournal({
                tenantId: req.auth.tenantId,
                branchId: count.branchId,
                referenceType: 'stock_adjustment',
                referenceId: count.countNumber,
                description: `Stock count gain ${count.countNumber}`,
                lines: [
                  { accountCode: '1050', debit: cost, credit: 0 },
                  { accountCode: '5040', debit: 0, credit: cost },
                ],
                createdBy: req.auth.userId,
                session,
              });
            }
          }
        }
      }
    }

    count.totalVarianceQty = totalVarianceQty;
    count.totalVarianceCostCents = totalVarianceCostCents;
    count.status = 'approved';
    count.approvedBy = req.auth.userId;
    count.approvedAt = new Date();
    await count.save({ session });

    await session.commitTransaction();
    session.endSession();

    await recordAudit({
      action: 'inventory.stock_count_approved',
      entity: 'StockCount',
      entityId: count._id,
      after: count.toObject(),
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });

    res.json({ success: true, data: maskCost(count, req.auth.role) });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

export async function listStockCounts(req, res) {
  const { page, limit, skip } = pageParams(req.query, 100);
  const branch = await resolveBranch(req, { allowAll: true });

  const filter = {};
  if (branch) filter.branchId = branch._id;
  if (req.query.status) filter.status = str(req.query.status);

  const [total, counts] = await Promise.all([
    StockCount.countDocuments(filter),
    StockCount.find(filter)
      .populate('branchId', 'name')
      .populate('startedBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json({
    success: true,
    total,
    page,
    limit,
    data: maskCost(counts, req.auth.role),
  });
}

export async function getStockCount(req, res) {
  const id = requireId(req.params.id);
  const count = await StockCount.findById(id)
    .populate('branchId', 'name')
    .populate('startedBy', 'name')
    .populate('approvedBy', 'name')
    .lean();

  if (!count) throw notFound('Stock count not found');
  res.json({ success: true, data: maskCost(count, req.auth.role) });
}

// ==========================================
// LOW STOCK ITEMS
// ==========================================

export async function getLowStockItems(req, res) {
  const branch = await resolveBranch(req);

  const products = await Product.find({ isArchived: false, reorderLevel: { $gt: 0 } })
    .populate('categoryId', 'name')
    .populate('brandId', 'name')
    .lean();

  const productIds = products.map((p) => p._id);
  const stockLevels = await StockLevel.find({ branchId: branch._id, productId: { $in: productIds } }).lean();
  const stockMap = new Map(stockLevels.map((sl) => [String(sl.productId), sl.qty]));

  const lowStock = products
    .map((p) => {
      const qty = stockMap.get(String(p._id)) || 0;
      return {
        ...p,
        qty,
        isLowStock: qty <= p.reorderLevel,
      };
    })
    .filter((p) => p.isLowStock);

  res.json({ success: true, count: lowStock.length, data: maskCost(lowStock, req.auth.role) });
}

// ==========================================
// CSV IMPORT (ALL OR NOTHING)
// ==========================================

export async function importProductsCsv(req, res) {
  const rows = req.body.rows || req.body.products || req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest('CSV data must contain an array of product rows');
  }

  const errors = [];
  const seenBarcodes = new Set();
  const seenSkus = new Set();

  // Validate every single row first
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    const name = str(row.name);
    if (!name) errors.push({ row: rowNum, field: 'name', message: 'Product name is required' });

    const barcode = str(row.barcode);
    if (!barcode) {
      errors.push({ row: rowNum, field: 'barcode', message: 'Barcode is required' });
    } else {
      if (seenBarcodes.has(barcode)) {
        errors.push({ row: rowNum, field: 'barcode', message: `Duplicate barcode '${barcode}' in import file` });
      }
      seenBarcodes.add(barcode);
    }

    const sku = str(row.sku);
    if (sku) {
      if (seenSkus.has(sku)) {
        errors.push({ row: rowNum, field: 'sku', message: `Duplicate SKU '${sku}' in import file` });
      }
      seenSkus.add(sku);
    }

    const sellingPriceCents = Number(row.sellingPriceCents ?? (row.sellingPrice ? Math.round(Number(row.sellingPrice) * 100) : NaN));
    if (isNaN(sellingPriceCents) || sellingPriceCents < 0) {
      errors.push({ row: rowNum, field: 'sellingPriceCents', message: 'Valid selling price is required' });
    }
  }

  // Check database for existing barcodes or SKUs in this tenant
  const existingBarcodes = await Product.find({ barcode: { $in: Array.from(seenBarcodes) }, isArchived: false }).select('barcode').lean();
  if (existingBarcodes.length > 0) {
    const existingSet = new Set(existingBarcodes.map((b) => b.barcode));
    rows.forEach((r, idx) => {
      if (existingSet.has(str(r.barcode))) {
        errors.push({ row: idx + 1, field: 'barcode', message: `Barcode '${r.barcode}' already exists in database` });
      }
    });
  }

  if (seenSkus.size > 0) {
    const existingSkus = await Product.find({ sku: { $in: Array.from(seenSkus) }, isArchived: false }).select('sku').lean();
    if (existingSkus.length > 0) {
      const existingSkuSet = new Set(existingSkus.map((b) => b.sku));
      rows.forEach((r, idx) => {
        if (r.sku && existingSkuSet.has(str(r.sku))) {
          errors.push({ row: idx + 1, field: 'sku', message: `SKU '${r.sku}' already exists in database` });
        }
      });
    }
  }

  // If any errors found, fail all-or-nothing
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Validation failed for ${errors.length} item(s)`,
      errors,
    });
  }

  // Batch insert inside transaction
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const toInsert = rows.map((r) => ({
      name: str(r.name),
      barcode: str(r.barcode),
      sku: str(r.sku) || '',
      description: str(r.description) || '',
      isSerialised: !!(r.isSerialised === true || r.isSerialised === 'true' || r.isSerialised === 1),
      sellingPriceCents: Number(r.sellingPriceCents ?? Math.round(Number(r.sellingPrice) * 100)),
      wholesalePriceCents: Number(r.wholesalePriceCents ?? (r.wholesalePrice ? Math.round(Number(r.wholesalePrice) * 100) : 0)) || 0,
      costPriceCents: Number(r.costPriceCents ?? (r.costPrice ? Math.round(Number(r.costPrice) * 100) : 0)) || 0,
      taxRatePercent: Number(r.taxRatePercent) || 0,
      reorderLevel: Number(r.reorderLevel) || 0,
    }));

    const created = await Product.create(toInsert, { session, ordered: true });

    await session.commitTransaction();
    session.endSession();

    await recordAudit({
      action: 'inventory.csv_imported',
      entity: 'Product',
      entityId: `${created.length} products`,
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });

    res.status(201).json({
      success: true,
      message: `Successfully imported ${created.length} products`,
      count: created.length,
      data: maskCost(created, req.auth.role),
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

export default {
  createAdjustment,
  listAdjustments,
  createStockCount,
  updateStockCount,
  approveStockCount,
  listStockCounts,
  getStockCount,
  getLowStockItems,
  importProductsCsv,
};
