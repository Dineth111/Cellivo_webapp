import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import * as imeiService from '../src/modules/inventory/services/imei.service.js';
import * as stockService from '../src/modules/inventory/services/stock.service.js';
import SerialUnit from '../src/modules/inventory/models/SerialUnit.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

// Helper to calculate Luhn check digit for a 14-digit prefix
function makeValidImei(prefix14 = '35693803564380') {
  let sum = 0;
  for (let i = 0; i < prefix14.length; i++) {
    let digit = parseInt(prefix14.charAt(i), 10);
    // When 15 digits total, position from right for index i (0-based) is 15 - i.
    // Even positions from right get multiplied by 2.
    if ((15 - i) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${prefix14}${checkDigit}`;
}

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Main') {
  const s = await signup(email, shopName);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;
  return { ...s, tenantId, branchId };
}

describe('F-07 IMEI Validation, Uniqueness & Model', () => {
  it('validates 15-digit Luhn checksum', () => {
    const validImei = makeValidImei('35209900176148');
    expect(imeiService.validateImei(validImei)).toBe(validImei);

    // 14 digits -> Fails
    expect(() => imeiService.validateImei('35209900176148')).toThrow(/must be exactly 15 digits/);
    // 16 digits -> Fails
    expect(() => imeiService.validateImei('3520990017614800')).toThrow(/must be exactly 15 digits/);
    // Bad check digit -> Fails Luhn
    const badCheckDigit = validImei.slice(0, 14) + (validImei.slice(14) === '0' ? '1' : '0');
    expect(() => imeiService.validateImei(badCheckDigit)).toThrow(/failed Luhn checksum/);
  });

  it('enforces IMEI uniqueness within a tenant but allows cross-tenant', async () => {
    const shopA = await setupShop('shopA@cellivo.lk', 'Shop A');
    const shopB = await setupShop('shopB@cellivo.lk', 'Shop B');

    const imei1 = makeValidImei('35900100111111');
    const imei2 = makeValidImei('35900100222222');

    const prodA = (await api('post', '/api/inventory/products', shopA.token).send({
      name: 'Phone A',
      barcode: 'PHONE-A',
      isSerialised: true,
      sellingPriceCents: 5000000,
    })).body.data;

    // Create SerialUnit in Shop A
    await runWithContext({ tenantId: shopA.tenantId }, async () => {
      await SerialUnit.create({
        imei1,
        imei2,
        productId: prodA._id,
        branchId: shopA.branchId,
        unitCostCents: 4000000,
      });
    });

    // Duplicate in Shop A -> Throws duplicate key error
    await expect(
      runWithContext({ tenantId: shopA.tenantId }, async () => {
        await SerialUnit.create({
          imei1,
          productId: prodA._id,
          branchId: shopA.branchId,
        });
      })
    ).rejects.toThrow();

    // Same IMEI in Shop B -> Succeeds (tenant isolated)
    const prodB = (await api('post', '/api/inventory/products', shopB.token).send({
      name: 'Phone B',
      barcode: 'PHONE-B',
      isSerialised: true,
      sellingPriceCents: 5000000,
    })).body.data;

    const unitB = await runWithContext({ tenantId: shopB.tenantId }, async () => {
      return await SerialUnit.create({
        imei1,
        productId: prodB._id,
        branchId: shopB.branchId,
      });
    });
    expect(unitB.imei1).toBe(imei1);
  });
});

describe('F-07 IMEI Status State Machine & Lifecycle', () => {
  it('enforces valid status transitions and blocks illegal state jumps', async () => {
    const shop = await setupShop();
    const imei = makeValidImei('35888800123456');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Galaxy Ultra',
      barcode: 'GALAXY-ULTRA',
      isSerialised: true,
      sellingPriceCents: 20000000,
    })).body.data;

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        imei1: imei,
        productId: prod._id,
        branchId: shop.branchId,
        status: 'in_stock',
      });
    });

    // in_stock -> returned: INVALID (must be sold first)
    await expect(
      imeiService.transitionStatus({
        tenantId: shop.tenantId,
        imei,
        newStatus: 'returned',
      })
    ).rejects.toThrow(/Cannot transition IMEI from 'in_stock' to 'returned'/);

    // in_stock -> reserved -> OK
    const resUnit = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'reserved',
      cartId: 'CART-100',
    });
    expect(resUnit.status).toBe('reserved');
    expect(resUnit.reservation.cartId).toBe('CART-100');

    // reserved -> sold -> OK
    const soldUnit = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'sold',
      cartId: 'CART-100',
    });
    expect(soldUnit.status).toBe('sold');

    // sold -> returned -> OK
    const retUnit = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'returned',
    });
    expect(retUnit.status).toBe('returned');

    // returned -> with_supplier -> OK
    const supUnit = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'with_supplier',
    });
    expect(supUnit.status).toBe('with_supplier');

    // with_supplier -> in_stock -> OK
    const backStock = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'in_stock',
    });
    expect(backStock.status).toBe('in_stock');
  });
});

describe('F-07 Cart-Tied Reservation Lock', () => {
  it('refuses to sell or reserve an IMEI locked by another cart', async () => {
    const shop = await setupShop();
    const imei = makeValidImei('35777700987654');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Pixel 8',
      barcode: 'PIXEL-8',
      isSerialised: true,
      sellingPriceCents: 18000000,
    })).body.data;

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        imei1: imei,
        productId: prod._id,
        branchId: shop.branchId,
        status: 'in_stock',
      });
    });

    // Cart 1 reserves IMEI
    const reserveRes = await api('post', `/api/inventory/imei/${imei}/reserve`, shop.token).send({
      cartId: 'CART-A',
      minutes: 15,
    });
    expect(reserveRes.status).toBe(200);
    expect(reserveRes.body.data.cartId).toBe('CART-A');

    // Cart 2 attempts to reserve same IMEI -> 400 Bad Request
    const cart2Reserve = await api('post', `/api/inventory/imei/${imei}/reserve`, shop.token).send({
      cartId: 'CART-B',
    });
    expect(cart2Reserve.status).toBe(400);
    expect(cart2Reserve.body.message).toContain('already reserved by another transaction');

    // Cart 2 attempts to sell/transition same IMEI -> 400 Bad Request
    await expect(
      imeiService.transitionStatus({
        tenantId: shop.tenantId,
        imei,
        newStatus: 'sold',
        cartId: 'CART-B',
      })
    ).rejects.toThrow(/reserved by another cart/);

    // Cart 1 completes sale -> 200 OK
    const sold = await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'sold',
      cartId: 'CART-A',
    });
    expect(sold.status).toBe('sold');
  });

  it('allows release and re-reservation', async () => {
    const shop = await setupShop();
    const imei = makeValidImei('35111100555555');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Nothing Phone 2',
      barcode: 'NOTHING-2',
      isSerialised: true,
      sellingPriceCents: 15000000,
    })).body.data;

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        imei1: imei,
        productId: prod._id,
        branchId: shop.branchId,
        status: 'in_stock',
      });
    });

    // Reserve
    await api('post', `/api/inventory/imei/${imei}/reserve`, shop.token).send({ cartId: 'CART-1' });

    // Release
    const relRes = await api('post', `/api/inventory/imei/${imei}/release`, shop.token);
    expect(relRes.status).toBe(200);

    // Cart 2 can now reserve
    const cart2Res = await api('post', `/api/inventory/imei/${imei}/reserve`, shop.token).send({ cartId: 'CART-2' });
    expect(cart2Res.status).toBe(200);
  });
});

describe('F-07 IMEI Search & Life-History Timeline', () => {
  it('searches IMEI and returns complete life history timeline from movement log', async () => {
    const shop = await setupShop();
    const imei = makeValidImei('35999900444444');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Sony Xperia 1 V',
      barcode: 'SONY-XP-1V',
      isSerialised: true,
      sellingPriceCents: 28000000,
      costPriceCents: 22000000,
    })).body.data;

    // Create serial unit & initial GRN movement
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        imei1: imei,
        serialNumber: 'SN-SONY-999',
        productId: prod._id,
        branchId: shop.branchId,
        unitCostCents: 22000000,
        grnNumber: 'GRN-2026-001',
      });
    });

    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId: prod._id,
      branchId: shop.branchId,
      type: 'purchase_grn',
      qtyChange: 1,
      unitCostCents: 22000000,
      referenceType: 'grn',
      referenceId: 'GRN-2026-001',
      imei,
      note: 'Received from Sony Distributor',
    });

    // Sale movement
    await imeiService.transitionStatus({
      tenantId: shop.tenantId,
      imei,
      newStatus: 'sold',
    });

    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId: prod._id,
      branchId: shop.branchId,
      type: 'sale',
      qtyChange: -1,
      referenceType: 'sale',
      referenceId: 'INV-2026-100',
      imei,
      note: 'Sold to customer',
    });

    // Search by partial IMEI or serial
    const searchRes = await api('get', `/api/inventory/imei/search?q=SONY-999`, shop.token);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data).toHaveLength(1);
    expect(searchRes.body.data[0].imei1).toBe(imei);

    // Timeline
    const timeRes = await api('get', `/api/inventory/imei/${imei}/timeline`, shop.token);
    expect(timeRes.status).toBe(200);
    expect(timeRes.body.data.serialUnit.imei1).toBe(imei);
    expect(timeRes.body.data.movements).toHaveLength(2);
    expect(timeRes.body.data.movements[0].type).toBe('purchase_grn');
    expect(timeRes.body.data.movements[1].type).toBe('sale');
  });
});

describe('Dev 4 review: 3. Status changes move stock & post ledger', () => {
  it('write-off lowers stock level, posts Dr 5040/Cr 1050, requires reason and audits; POS cannot sell by barcode; return to stock reverses', async () => {
    const shop = await setupShop('status-stock@shop.lk', 'Status Stock Shop');
    const imei = makeValidImei('35222200333333');

    const prod = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Write-off Device',
      barcode: 'BC-WRITEOFF-1',
      isSerialised: true,
      sellingPriceCents: 5000000,
      costPriceCents: 3000000,
    })).body.data;

    // Seed stock of 1 unit
    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId: prod._id,
      branchId: shop.branchId,
      type: 'initial',
      qtyChange: 1,
      unitCostCents: 3000000,
    });

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        tenantId: shop.tenantId,
        imei1: imei,
        productId: prod._id,
        branchId: shop.branchId,
        unitCostCents: 3000000,
        status: 'in_stock',
      });
    });

    // 1. Manual status change without reason -> 400 Bad Request
    const noReasonRes = await api('post', `/api/inventory/imei/${imei}/status`, shop.token).send({
      status: 'written_off',
    });
    expect(noReasonRes.status).toBe(400);

    // 2. Manual status change with reason -> 200 OK
    const writeOffRes = await api('post', `/api/inventory/imei/${imei}/status`, shop.token).send({
      status: 'written_off',
      reason: 'Water damage during storage',
    });
    expect(writeOffRes.status).toBe(200);

    // StockLevel.qty lowered from 1 to 0
    const slAfterWriteOff = await stockService.getStockLevel(shop.tenantId, shop.branchId, prod._id);
    expect(slAfterWriteOff.qty).toBe(0);

    // Ledger posted Dr 5040 / Cr 1050 for 3000000 cents
    const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceId: imei }).lean();
    });
    expect(entries.length).toBeGreaterThan(0);
    const writeOffEntry = entries[0];
    const drLine = writeOffEntry.lines.find((l) => l.accountCode === '5040');
    const crLine = writeOffEntry.lines.find((l) => l.accountCode === '1050');
    expect(drLine.debit).toBe(3000000);
    expect(crLine.credit).toBe(3000000);

    // Audited as inventory.imei_status with reason and before/after
    const auditLogs = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await AuditLog.find({ action: 'inventory.imei_status', entityId: writeOffRes.body.data._id }).lean();
    });
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].before.status).toBe('in_stock');
    expect(auditLogs[0].after.status).toBe('written_off');
    expect(auditLogs[0].after.reason).toBe('Water damage during storage');

    // POS cannot sell the written-off unit by barcode (stock qty is 0)
    const sellRes = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [{ barcode: 'BC-WRITEOFF-1', qty: 1 }],
      payments: [{ method: 'cash', amountCents: 5000000 }],
    });
    expect(sellRes.status).toBe(400);
    expect(sellRes.body.code).toBe('V-05');

    // 3. Bring unit back to in_stock
    const backRes = await api('post', `/api/inventory/imei/${imei}/status`, shop.token).send({
      status: 'in_stock',
      reason: 'Recovered and repaired',
    });
    expect(backRes.status).toBe(200);

    // StockLevel.qty increased back to 1
    const slAfterBack = await stockService.getStockLevel(shop.tenantId, shop.branchId, prod._id);
    expect(slAfterBack.qty).toBe(1);

    // Ledger posted Dr 1050 / Cr 5040 for 3000000 cents
    const allEntries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceId: imei }).sort({ createdAt: -1 }).lean();
    });
    expect(allEntries.length).toBe(2);
    const reverseEntry = allEntries[0];
    const revDrLine = reverseEntry.lines.find((l) => l.accountCode === '1050');
    const revCrLine = reverseEntry.lines.find((l) => l.accountCode === '5040');
    expect(revDrLine.debit).toBe(3000000);
    expect(revCrLine.credit).toBe(3000000);
  });
});

