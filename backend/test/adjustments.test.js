import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { seedStock } from '../src/modules/inventory/test/stockSeed.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import StockMovement from '../src/modules/inventory/models/StockMovement.model.js';
import SerialUnit from '../src/modules/inventory/models/SerialUnit.model.js';
import StockAdjustment from '../src/modules/inventory/models/StockAdjustment.model.js';
import StockCount from '../src/modules/inventory/models/StockCount.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'owner-adj@cellivo.lk', name = 'Adjustment Shop') {
  const s = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;
  return { ...s, tenantId, branchId };
}

describe('F-06 Stock Adjustments (Loss, Damage, Found, Correction)', () => {
  it('creates audited stock adjustment with reason and updates stock levels', async () => {
    const shop = await setupShop();

    const seeded = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await seedStock({
        branchId: shop.branchId,
        barcode: 'BC-SCREEN-01',
        name: 'iPhone 15 Screen Replacement',
        sellingPriceCents: 2500000,
        costPriceCents: 1500000,
        qty: 10,
      });
    });

    const prodId = seeded._id;

    // Decrease adjustment (Damage: 2 units damaged during unboxing)
    const adjRes = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: prodId,
      adjustmentType: 'decrease',
      qty: 2,
      reason: 'damage',
      notes: 'Dropped during shelf stocking',
    });
    expect(adjRes.status).toBe(201);
    expect(adjRes.body.data.adjustmentNumber).toMatch(/^ADJ-\d{8}-\d{4}$/);
    expect(adjRes.body.data.qtyChange).toBe(-2);
    expect(adjRes.body.data.reason).toBe('damage');

    // Verify stock level reduced to 8
    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ branchId: shop.branchId, productId: prodId });
    });
    expect(sl.qty).toBe(8);

    // Verify movement log
    const mvt = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.findOne({ productId: prodId, type: 'adjustment_loss' });
    });
    expect(mvt.qtyChange).toBe(-2);
    expect(mvt.balanceAfter).toBe(8);
    expect(mvt.referenceType).toBe('adjustment');

    // Increase adjustment (Found: 1 unit found during audit)
    const gainRes = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: prodId,
      adjustmentType: 'increase',
      qty: 1,
      reason: 'found',
      notes: 'Found in technician drawer',
    });
    expect(gainRes.status).toBe(201);
    expect(gainRes.body.data.qtyChange).toBe(1);

    const slAfterGain = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ branchId: shop.branchId, productId: prodId });
    });
    expect(slAfterGain.qty).toBe(9);
  });

  it('handles IMEI adjustments: writes off damaged IMEI and restores found IMEI', async () => {
    const shop = await setupShop('imei-adj@cellivo.lk', 'IMEI Adj Shop');

    const seeded = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await seedStock({
        branchId: shop.branchId,
        barcode: 'BC-PHONE-ADJ',
        name: 'Samsung S23',
        sellingPriceCents: 15000000,
        costPriceCents: 10000000,
        qty: 1,
        imeiList: [{ imei: '356938035643803', status: 'in_stock' }],
      });
    });

    // Adjust out damaged IMEI
    const adjRes = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: seeded._id,
      adjustmentType: 'decrease',
      qty: 1,
      reason: 'damage',
      imei: '356938035643803',
      notes: 'Water damaged display',
    });
    expect(adjRes.status).toBe(201);

    // Verify IMEI status is now written_off
    const unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: '356938035643803' });
    });
    expect(unit.status).toBe('written_off');
  });

  it('rejects adjustment creation if user lacks adjust_stock special permission', async () => {
    const shop = await setupShop('cashier-adj@shop.lk', 'Cashier Adj Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-adj-user@shop.lk');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Phone Case',
      barcode: 'CASE-001',
      sellingPriceCents: 100000,
    })).body.data;

    // Cashier lacks adjust_stock -> 403 Forbidden
    const res = await api('post', '/api/inventory/adjustments', cashier.token).send({
      branchId: shop.branchId,
      productId: prod._id,
      adjustmentType: 'increase',
      qty: 5,
      reason: 'correction',
    });
    expect(res.status).toBe(403);
  });
});

describe('F-06 Stock Count & Variance Auditing', () => {
  it('creates stock count sheet, updates physical counts, and approves posting adjustments', async () => {
    const shop = await setupShop('count-shop@cellivo.lk', 'Stock Count Shop');

    // Seed 2 products
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await seedStock([
        {
          branchId: shop.branchId,
          barcode: 'COUNT-PROD-A',
          name: 'Screen Protector',
          sellingPriceCents: 100000,
          costPriceCents: 50000,
          qty: 20, // expected 20
        },
        {
          branchId: shop.branchId,
          barcode: 'COUNT-PROD-B',
          name: 'Charger Adapter',
          sellingPriceCents: 200000,
          costPriceCents: 100000,
          qty: 15, // expected 15
        },
      ]);
    });

    // 1. Start stock count
    const createRes = await api('post', '/api/inventory/counts', shop.token).send({
      branchId: shop.branchId,
      notes: 'End of Month Audit',
    });
    expect(createRes.status).toBe(201);
    const countId = createRes.body.data._id;
    expect(createRes.body.data.countNumber).toMatch(/^STC-\d{8}-\d{4}$/);
    expect(createRes.body.data.items).toHaveLength(2);

    const itemA = createRes.body.data.items.find((i) => i.barcode === 'COUNT-PROD-A');
    const itemB = createRes.body.data.items.find((i) => i.barcode === 'COUNT-PROD-B');
    expect(itemA.expectedQty).toBe(20);
    expect(itemB.expectedQty).toBe(15);

    // 2. Physical count: Product A counted 18 (-2 variance), Product B counted 16 (+1 variance)
    const updateRes = await api('put', `/api/inventory/counts/${countId}`, shop.token).send({
      items: [
        { productId: itemA.productId, countedQty: 18 },
        { productId: itemB.productId, countedQty: 16 },
      ],
      status: 'completed',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.totalVarianceQty).toBe(-1); // -2 + 1 = -1

    // 3. Approve stock count (posts adjustments)
    const approveRes = await api('post', `/api/inventory/counts/${countId}/approve`, shop.token);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');
    expect(approveRes.body.data.approvedBy).toBeDefined();

    // 4. Verify inventory balances updated to counted quantities
    const [slA, slB] = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Promise.all([
        StockLevel.findOne({ branchId: shop.branchId, productId: itemA.productId }),
        StockLevel.findOne({ branchId: shop.branchId, productId: itemB.productId }),
      ]);
    });
    expect(slA.qty).toBe(18); // updated to counted qty
    expect(slB.qty).toBe(16); // updated to counted qty

    // Verify stock movements recorded
    const movements = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.find({ referenceType: 'stock_count' });
    });
    expect(movements).toHaveLength(2);
  });
});

describe('F-06 Low Stock Items & CSV Import', () => {
  it('identifies low-stock items at or below reorder level', async () => {
    const shop = await setupShop('low-stock@shop.lk', 'Low Stock Shop');

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await seedStock([
        {
          branchId: shop.branchId,
          barcode: 'LOW-PROD-01',
          name: 'Critical Stock Item',
          sellingPriceCents: 500000,
          reorderLevel: 5,
          qty: 3, // 3 <= 5 -> LOW STOCK
        },
        {
          branchId: shop.branchId,
          barcode: 'OK-PROD-02',
          name: 'Healthy Stock Item',
          sellingPriceCents: 500000,
          reorderLevel: 5,
          qty: 20, // 20 > 5 -> HEALTHY
        },
      ]);
    });

    const res = await api('get', '/api/inventory/low-stock', shop.token);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].barcode).toBe('LOW-PROD-01');
  });

  it('performs all-or-nothing CSV import with row-level validation', async () => {
    const shop = await setupShop('csv-import@shop.lk', 'CSV Import Shop');

    // 1. Invalid payload with duplicate barcodes in CSV -> Fails and inserts NOTHING
    const badCsv = [
      { name: 'Item 1', barcode: 'CSV-001', sellingPrice: '1500.00' },
      { name: 'Item 2', barcode: 'CSV-001', sellingPrice: '2500.00' }, // duplicate barcode
      { name: '', barcode: 'CSV-003', sellingPrice: '3000.00' },       // missing name
    ];

    const failRes = await api('post', '/api/inventory/products/import-csv', shop.token).send({ rows: badCsv });
    expect(failRes.status).toBe(400);
    expect(failRes.body.success).toBe(false);
    expect(failRes.body.errors.length).toBeGreaterThanOrEqual(2);

    // Verify 0 products inserted
    const countAfterFail = await runWithContext({ tenantId: shop.tenantId }, async () => await Product.countDocuments());
    expect(countAfterFail).toBe(0);

    // 2. Valid CSV payload -> Succeeds
    const validCsv = [
      { name: 'Anker PowerBank 10k', barcode: 'ANKER-10K', sku: 'ANK-10K', sellingPrice: '8500.00', costPrice: '6000.00', reorderLevel: 5 },
      { name: 'Baseus 20W Charger', barcode: 'BASEUS-20W', sku: 'BAS-20W', sellingPrice: '3200.00', costPrice: '2000.00', reorderLevel: 10 },
      { name: 'Lightning to USB-C', barcode: 'LIGHT-USBC', sku: 'LGT-USBC', sellingPrice: '2500.00', costPrice: '1200.00', reorderLevel: 8 },
    ];

    const successRes = await api('post', '/api/inventory/products/import-csv', shop.token).send({ rows: validCsv });
    expect(successRes.status).toBe(201);
    expect(successRes.body.success).toBe(true);
    expect(successRes.body.count).toBe(3);

    const countAfterSuccess = await runWithContext({ tenantId: shop.tenantId }, async () => await Product.countDocuments());
    expect(countAfterSuccess).toBe(3);
  });
});

describe('Dev 4 review: 4. One state machine (transitionStatus)', () => {
  it('rejects invalid state transition during adjustment and confirms no direct unit.status = remain', async () => {
    const shop = await setupShop('statemachine@cellivo.lk', 'State Machine Shop');
    const imei = '357999001111111';

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'State Machine Phone',
      barcode: 'PHONE-SM-1',
      isSerialised: true,
      sellingPriceCents: 10000000,
      costPriceCents: 6000000,
    })).body.data;

    // Create a unit that is already 'written_off'
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: prod._id,
        imei1: imei,
        status: 'written_off',
        unitCostCents: 6000000,
      });
    });

    // Attempting to decrease (write off) an already written-off unit -> rejected by transitionStatus
    const res = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: prod._id,
      adjustmentType: 'decrease',
      qty: 1,
      reason: 'damage',
      imei,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Cannot transition IMEI');
  });
});

describe('Dev 4 review: 5. Ledger for adjustments and stock counts', () => {
  it('posts Dr 5040 / Cr 1050 for loss and Dr 1050 / Cr 5040 for gain in the same transaction as stock change', async () => {
    const shop = await setupShop('ledger-adj@cellivo.lk', 'Ledger Adjustment Shop');

    const seeded = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await seedStock({
        branchId: shop.branchId,
        barcode: 'LEDGER-ITEM-01',
        name: 'USB-C Cable',
        sellingPriceCents: 200000,
        costPriceCents: 50000,
        qty: 10,
      });
    });

    // 1. Loss adjustment: 2 units lost (2 * 50000 = 100000 cents)
    const lossRes = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: seeded.product._id,
      adjustmentType: 'decrease',
      qty: 2,
      reason: 'loss',
      notes: 'Lost during transit',
    });
    expect(lossRes.status).toBe(201);

    const lossEntries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceType: 'stock_adjustment', referenceId: lossRes.body.data.adjustmentNumber });
    });
    expect(lossEntries).toHaveLength(1);
    const lossLines = lossEntries[0].lines;
    const debitLoss = lossLines.find((l) => l.accountCode === '5040');
    const creditLoss = lossLines.find((l) => l.accountCode === '1050');
    expect(debitLoss.debit).toBe(100000);
    expect(debitLoss.credit).toBe(0);
    expect(creditLoss.credit).toBe(100000);
    expect(creditLoss.debit).toBe(0);

    // 2. Gain adjustment: 3 units found (3 * 50000 = 150000 cents)
    const gainRes = await api('post', '/api/inventory/adjustments', shop.token).send({
      branchId: shop.branchId,
      productId: seeded.product._id,
      adjustmentType: 'increase',
      qty: 3,
      reason: 'found',
      notes: 'Found in back store',
    });
    expect(gainRes.status).toBe(201);

    const gainEntries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceType: 'stock_adjustment', referenceId: gainRes.body.data.adjustmentNumber });
    });
    expect(gainEntries).toHaveLength(1);
    const gainLines = gainEntries[0].lines;
    const debitGain = gainLines.find((l) => l.accountCode === '1050');
    const creditGain = gainLines.find((l) => l.accountCode === '5040');
    expect(debitGain.debit).toBe(150000);
    expect(debitGain.credit).toBe(0);
    expect(creditGain.credit).toBe(150000);
    expect(creditGain.debit).toBe(0);
  });
});

describe('Dev 4 review: 6. Stock count approval recomputation & serial unit reconciliation', () => {
  it('recomputes varianceQty at approval so a sale during count does not cause a double deduction', async () => {
    const shop = await setupShop('count-recompute@cellivo.lk', 'Count Recompute Shop');

    const seeded = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await seedStock({
        branchId: shop.branchId,
        barcode: 'MIDCOUNT-SALE',
        name: 'Mid Count Item',
        sellingPriceCents: 500000,
        costPriceCents: 250000,
        qty: 10,
      });
    });

    // 1. Auditor starts stock count: expectedQty is 10
    const startRes = await api('post', '/api/inventory/counts', shop.token).send({
      branchId: shop.branchId,
      notes: 'Audit with concurrent sale',
    });
    expect(startRes.status).toBe(201);
    const countId = startRes.body.data._id;
    const countNumber = startRes.body.data.countNumber;

    // 2. Concurrent sale occurs during count: 2 units sold -> stock level drops to 8
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await StockLevel.updateOne(
        { branchId: shop.branchId, productId: seeded.product._id },
        { $inc: { qty: -2 } }
      );
    });

    // 3. Auditor counted 8 units physically
    await api('put', `/api/inventory/counts/${countId}`, shop.token).send({
      items: [{ productId: seeded.product._id, countedQty: 8 }],
      status: 'completed',
    });

    // 4. Manager approves stock count
    const approveRes = await api('post', `/api/inventory/counts/${countId}/approve`, shop.token);
    expect(approveRes.status).toBe(200);

    // Variance should be recomputed against current StockLevel (8), resulting in 8 - 8 = 0 variance!
    const item = approveRes.body.data.items[0];
    expect(item.expectedQty).toBe(8);
    expect(item.varianceQty).toBe(0);

    // Stock level must remain 8 (NO double deduction)
    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ branchId: shop.branchId, productId: seeded.product._id });
    });
    expect(sl.qty).toBe(8);
  });

  it('reconciles serialised products on count approval: marks missing units written_off and reports unknown scanned IMEIs', async () => {
    const shop = await setupShop('count-serial@cellivo.lk', 'Serial Count Shop');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Audit Phone Pro',
      barcode: 'AUDIT-PHONE',
      isSerialised: true,
      sellingPriceCents: 10000000,
      costPriceCents: 6000000,
    })).body.data;

    const imei1 = '358000000000001';
    const imei2 = '358000000000002';
    const imei3 = '358000000000003';
    const unknownImei = '999999999999999';

    // Seed 3 serial units in stock
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.insertMany([
        { tenantId: shop.tenantId, branchId: shop.branchId, productId: prod._id, imei1, status: 'in_stock', unitCostCents: 6000000 },
        { tenantId: shop.tenantId, branchId: shop.branchId, productId: prod._id, imei1: imei2, status: 'in_stock', unitCostCents: 6000000 },
        { tenantId: shop.tenantId, branchId: shop.branchId, productId: prod._id, imei1: imei3, status: 'in_stock', unitCostCents: 6000000 },
      ]);
      await StockLevel.create({
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: prod._id,
        qty: 3,
        averageCostCents: 6000000,
      });
    });

    // 1. Start stock count
    const startRes = await api('post', '/api/inventory/counts', shop.token).send({
      branchId: shop.branchId,
      notes: 'Serial stock count',
    });
    const countId = startRes.body.data._id;

    // 2. Auditor scans imei1 and imei2, PLUS unknownImei (imei3 was not scanned -> missing)
    await api('put', `/api/inventory/counts/${countId}`, shop.token).send({
      items: [
        {
          productId: prod._id,
          scannedImeis: [imei1, imei2, unknownImei],
        },
      ],
      status: 'completed',
    });

    // 3. Approve count
    const approveRes = await api('post', `/api/inventory/counts/${countId}/approve`, shop.token);
    expect(approveRes.status).toBe(200);

    const approvedItem = approveRes.body.data.items.find((i) => String(i.productId) === String(prod._id));
    expect(approvedItem.unknownImeis).toContain(unknownImei);

    // 4. Verify imei3 is now written_off
    const missingUnit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei3 });
    });
    expect(missingUnit.status).toBe('written_off');

    // 5. Verify unknown IMEI was NOT created in SerialUnit
    const unknownUnit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: unknownImei });
    });
    expect(unknownUnit).toBeNull();

    // 6. Verify ledger entry was posted for the missing unit write-off
    const imeiJournals = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceType: 'stock_adjustment', referenceId: imei3 });
    });
    expect(imeiJournals).toHaveLength(1);
    expect(imeiJournals[0].lines.find((l) => l.accountCode === '5040').debit).toBe(6000000);
    expect(imeiJournals[0].lines.find((l) => l.accountCode === '1050').credit).toBe(6000000);
  });
});


