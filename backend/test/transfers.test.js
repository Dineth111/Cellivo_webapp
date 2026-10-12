import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addBranch, addStaff } from './api.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import SerialUnit from '../src/modules/inventory/models/SerialUnit.model.js';
import StockTransfer from '../src/modules/inventory/models/StockTransfer.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

function makeValidImei(prefix14 = '35693803564380') {
  let sum = 0;
  for (let i = 0; i < prefix14.length; i++) {
    let digit = parseInt(prefix14.charAt(i), 10);
    if ((15 - i) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${prefix14}${checkDigit}`;
}

async function setupTwoBranchShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Telecom') {
  const s = await signup(email, shopName);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const user = meRes.body.data;
  const branchRes = await api('get', '/api/branches', s.token);
  const branch1Id = branchRes.body.data[0]._id;

  // Add second branch and give owner access to it
  const branch2 = await addBranch(tenantId, { name: 'Kandy Branch', userIds: [user._id] });
  const branch2Id = branch2._id;

  return { ...s, tenantId, user, branch1Id, branch2Id };
}

describe('F-16 Stock Transfers (BR-02)', () => {
  it('1. Request transfer: validates branches, items, and creates transfer document in requested status', async () => {
    const shop = await setupTwoBranchShop();

    // Create a product
    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Baseus PowerBank 20000mAh',
      barcode: 'BAS-PB-20K',
      costPriceCents: 500000,
      sellingPriceCents: 750000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    // Same branch request rejected
    const sameBranchRes = await api('post', '/api/inventory/transfers', shop.token).send({
      fromBranchId: shop.branch1Id,
      toBranchId: shop.branch1Id,
      items: [{ productId, requestedQty: 5 }],
    });
    expect(sameBranchRes.status).toBe(400);

    // Valid transfer request
    const reqRes = await api('post', '/api/inventory/transfers', shop.token).send({
      fromBranchId: shop.branch1Id,
      toBranchId: shop.branch2Id,
      items: [{ productId, requestedQty: 5 }],
      notes: 'Replenishing Kandy stock',
    });
    expect(reqRes.status).toBe(201);
    const transfer = reqRes.body.data;
    expect(transfer.transferNumber).toMatch(/^TRF-/);
    expect(transfer.status).toBe('requested');
    expect(transfer.items[0].requestedQty).toBe(5);
    expect(transfer.items[0].dispatchedQty).toBe(0);
    expect(transfer.items[0].receivedQty).toBe(0);

    // List transfers
    const listRes = await api('get', '/api/inventory/transfers', shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].transferNumber).toBe(transfer.transferNumber);
  });

  it('2. Complete transfer lifecycle: Request -> Approve -> Dispatch -> Receive (Non-serialised & Serialised)', async () => {
    const shop = await setupTwoBranchShop();

    // 1. Create a non-serialised product and serialised phone
    const cableRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Lightning Charging Cable',
      barcode: 'CABLE-LT-01',
      costPriceCents: 30000,
      sellingPriceCents: 60000,
      isSerialised: false,
    });
    const cableId = cableRes.body.data._id;

    const phoneRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'iPhone 15 128GB',
      barcode: 'IPHONE-15-128',
      costPriceCents: 22000000,
      sellingPriceCents: 26000000,
      isSerialised: true,
    });
    const phoneId = phoneRes.body.data._id;

    const imei1 = makeValidImei('35810009111111');
    const imei2 = makeValidImei('35810009111112');

    // Supplier GRN at Branch 1 to seed initial inventory
    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Apple LK Authorized',
    });
    const supplierId = supRes.body.data._id;

    await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branch1Id,
      supplierId,
      paymentType: 'credit',
      items: [
        { productId: cableId, qty: 10, unitCostCents: 30000 },
        { productId: phoneId, qty: 2, unitCostCents: 22000000, imeis: [imei1, imei2] },
      ],
    });

    // 2. Request transfer from Branch 1 to Branch 2
    const reqRes = await api('post', '/api/inventory/transfers', shop.token).send({
      fromBranchId: shop.branch1Id,
      toBranchId: shop.branch2Id,
      items: [
        { productId: cableId, requestedQty: 4 },
        { productId: phoneId, requestedQty: 2 },
      ],
      notes: 'Transfer 4 cables and 2 iPhones to Branch 2',
    });
    const transferId = reqRes.body.data._id;

    // 3. Approve transfer
    const appRes = await api('post', `/api/inventory/transfers/${transferId}/approve`, shop.token);
    expect(appRes.status).toBe(200);
    expect(appRes.body.data.status).toBe('approved');
    expect(appRes.body.data.approvedBy).toBeTruthy();

    // 4. Dispatch transfer with specific IMEIs
    const dispRes = await api('post', `/api/inventory/transfers/${transferId}/dispatch`, shop.token).send({
      items: [
        { productId: cableId, dispatchedQty: 4 },
        { productId: phoneId, dispatchedQty: 2, imeis: [imei1, imei2] },
      ],
    });
    expect(dispRes.status).toBe(200);
    const dispatchedTransfer = dispRes.body.data;
    expect(dispatchedTransfer.status).toBe('dispatched');
    expect(dispatchedTransfer.items[0].dispatchedQty).toBe(4);
    expect(dispatchedTransfer.items[1].dispatchedQty).toBe(2);

    // Verify stock at Branch 1 is reduced and IMEIs are in_transit
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const cableLevelB1 = await StockLevel.findOne({ productId: cableId, branchId: shop.branch1Id });
      expect(cableLevelB1.qty).toBe(6); // 10 - 4

      const phoneLevelB1 = await StockLevel.findOne({ productId: phoneId, branchId: shop.branch1Id });
      expect(phoneLevelB1.qty).toBe(0); // 2 - 2

      const units = await SerialUnit.find({ productId: phoneId });
      expect(units).toHaveLength(2);
      expect(units.every((u) => u.status === 'in_transit')).toBe(true);
    });

    // 5. Receive transfer at Branch 2
    const recvRes = await api('post', `/api/inventory/transfers/${transferId}/receive`, shop.token).send({
      items: [
        { productId: cableId, receivedQty: 4 },
        { productId: phoneId, receivedQty: 2, receivedImeis: [imei1, imei2] },
      ],
      notes: 'All items received in excellent condition',
    });
    expect(recvRes.status).toBe(200);
    const completedTransfer = recvRes.body.data;
    expect(completedTransfer.status).toBe('completed');
    expect(completedTransfer.items[0].receivedQty).toBe(4);
    expect(completedTransfer.items[1].receivedQty).toBe(2);
    expect(completedTransfer.items[0].discrepancyQty).toBe(0);
    expect(completedTransfer.items[1].discrepancyQty).toBe(0);

    // Verify stock at Branch 2 is increased and IMEIs are now in_stock at Branch 2
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const cableLevelB2 = await StockLevel.findOne({ productId: cableId, branchId: shop.branch2Id });
      expect(cableLevelB2.qty).toBe(4);

      const phoneLevelB2 = await StockLevel.findOne({ productId: phoneId, branchId: shop.branch2Id });
      expect(phoneLevelB2.qty).toBe(2);

      const units = await SerialUnit.find({ productId: phoneId });
      expect(units.every((u) => u.status === 'in_stock')).toBe(true);
      expect(units.every((u) => String(u.branchId) === String(shop.branch2Id))).toBe(true);

      // Verify inter-branch ledger journal: Dr 1050 / Cr 1050
      const entry = await LedgerEntry.findOne({ referenceId: completedTransfer.transferNumber });
      expect(entry).toBeTruthy();
      expect(entry.referenceType).toBe('transfer');
      expect(entry.lines).toHaveLength(2);
      const dr = entry.lines.find((l) => l.debit > 0);
      const cr = entry.lines.find((l) => l.credit > 0);
      expect(dr.accountCode).toBe('1050');
      expect(cr.accountCode).toBe('1050');
      expect(dr.debit).toBe(cr.credit);
    });
  });

  it('3. Partial receipt and discrepancy tracking', async () => {
    const shop = await setupTwoBranchShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Samsung 25W Adapter',
      barcode: 'SAM-25W-AD',
      costPriceCents: 40000,
      sellingPriceCents: 75000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    // Seed stock at Branch 1
    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Samsung Dist',
    });
    await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branch1Id,
      supplierId: supRes.body.data._id,
      items: [{ productId, qty: 20, unitCostCents: 40000 }],
    });

    // Request & Approve transfer of 10 units
    const reqRes = await api('post', '/api/inventory/transfers', shop.token).send({
      fromBranchId: shop.branch1Id,
      toBranchId: shop.branch2Id,
      items: [{ productId, requestedQty: 10 }],
    });
    const transferId = reqRes.body.data._id;

    await api('post', `/api/inventory/transfers/${transferId}/approve`, shop.token);
    await api('post', `/api/inventory/transfers/${transferId}/dispatch`, shop.token);

    // Receive only 7 units with a discrepancy note of 3 units damaged in transit
    const recvRes = await api('post', `/api/inventory/transfers/${transferId}/receive`, shop.token).send({
      items: [
        {
          productId,
          receivedQty: 7,
          discrepancyNote: '3 units crushed during transit',
        },
      ],
    });
    expect(recvRes.status).toBe(200);
    const partialTransfer = recvRes.body.data;
    expect(partialTransfer.status).toBe('partially_received');
    expect(partialTransfer.items[0].dispatchedQty).toBe(10);
    expect(partialTransfer.items[0].receivedQty).toBe(7);
    expect(partialTransfer.items[0].discrepancyQty).toBe(3);
    expect(partialTransfer.items[0].discrepancyNote).toBe('3 units crushed during transit');

    // Verify stock at Branch 2 has exactly 7
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const slB2 = await StockLevel.findOne({ productId, branchId: shop.branch2Id });
      expect(slB2.qty).toBe(7);
    });
  });

  it('4. Cancel transfer: restores dispatched stock and returns IMEIs to in_stock at source branch', async () => {
    const shop = await setupTwoBranchShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Google Pixel 8',
      barcode: 'PIXEL-8-128',
      costPriceCents: 15000000,
      sellingPriceCents: 18000000,
      isSerialised: true,
    });
    const productId = prodRes.body.data._id;
    const imei = makeValidImei('35200009123456');

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Pixel Wholesale',
    });
    await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branch1Id,
      supplierId: supRes.body.data._id,
      items: [{ productId, qty: 1, unitCostCents: 15000000, imeis: [imei] }],
    });

    // Request, approve and dispatch transfer
    const reqRes = await api('post', '/api/inventory/transfers', shop.token).send({
      fromBranchId: shop.branch1Id,
      toBranchId: shop.branch2Id,
      items: [{ productId, requestedQty: 1 }],
    });
    const transferId = reqRes.body.data._id;

    await api('post', `/api/inventory/transfers/${transferId}/approve`, shop.token);
    await api('post', `/api/inventory/transfers/${transferId}/dispatch`, shop.token).send({
      items: [{ productId, dispatchedQty: 1, imeis: [imei] }],
    });

    // Cancel transfer while in dispatched status
    const cancelRes = await api('post', `/api/inventory/transfers/${transferId}/cancel`, shop.token).send({
      reason: 'Driver vehicle breakdown, returning items to source branch',
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');

    // Verify stock and IMEI restored at Branch 1
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const slB1 = await StockLevel.findOne({ productId, branchId: shop.branch1Id });
      expect(slB1.qty).toBe(1);

      const unit = await SerialUnit.findOne({ imei1: imei });
      expect(unit.status).toBe('in_stock');
      expect(String(unit.branchId)).toBe(String(shop.branch1Id));
    });
  });
});
