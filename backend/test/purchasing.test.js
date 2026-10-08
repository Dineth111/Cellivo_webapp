import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import SerialUnit from '../src/modules/inventory/models/SerialUnit.model.js';
import Supplier from '../src/modules/inventory/models/Supplier.model.js';
import PurchaseOrder from '../src/modules/inventory/models/PurchaseOrder.model.js';
import GoodsReceivedNote from '../src/modules/inventory/models/GoodsReceivedNote.model.js';
import SupplierBill from '../src/modules/inventory/models/SupplierBill.model.js';
import SupplierPayment from '../src/modules/inventory/models/SupplierPayment.model.js';
import PurchaseReturn from '../src/modules/inventory/models/PurchaseReturn.model.js';
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

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Telecom') {
  const s = await signup(email, shopName);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;
  return { ...s, tenantId, branchId };
}

describe('F-08 Purchasing and Suppliers (PUR-01 to PUR-06)', () => {
  it('1. Handles Supplier CRUD with unique name per tenant', async () => {
    const shop = await setupShop();

    // Create supplier
    const createRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Singer Sri Lanka',
      contactPerson: 'Sunil Perera',
      phone: '0112345678',
      email: 'singer@lk.com',
      paymentTermsDays: 45,
      openingBalanceCents: 500000, // 5,000 LKR
      notes: 'Key distributor',
    });
    expect(createRes.status).toBe(201);
    const supplierId = createRes.body.data._id;
    expect(createRes.body.data.name).toBe('Singer Sri Lanka');
    expect(createRes.body.data.currentBalanceCents).toBe(500000);

    // Duplicate name rejected in same tenant
    const dupRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Singer Sri Lanka',
    });
    expect([400, 409]).toContain(dupRes.status);

    // List with search
    const listRes = await api('get', '/api/inventory/suppliers?search=Singer', shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].contactPerson).toBe('Sunil Perera');

    // Update
    const upRes = await api('put', `/api/inventory/suppliers/${supplierId}`, shop.token).send({
      phone: '0112999999',
    });
    expect(upRes.status).toBe(200);
    expect(upRes.body.data.phone).toBe('0112999999');

    // Archive
    const delRes = await api('delete', `/api/inventory/suppliers/${supplierId}`, shop.token);
    expect(delRes.status).toBe(200);

    const afterList = await api('get', '/api/inventory/suppliers', shop.token);
    expect(afterList.body.data).toHaveLength(0);
  });

  it('2. Purchase Orders: create, calculate total cents, and update status', async () => {
    const shop = await setupShop();

    // Create a product
    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Anker PowerBank 10000mAh',
      barcode: 'ANK-PB-10K',
      costPriceCents: 450000,
      sellingPriceCents: 650000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    // Create supplier
    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Anker LK Distributor',
    });
    const supplierId = supRes.body.data._id;

    // Create PO
    const poRes = await api('post', '/api/inventory/purchase-orders', shop.token).send({
      supplierId,
      branchId: shop.branchId,
      items: [
        {
          productId,
          qty: 10,
          unitCostCents: 450000, // 4,500 LKR
        },
      ],
      notes: 'Initial stock order',
    });
    expect(poRes.status).toBe(201);
    const po = poRes.body.data;
    expect(po.poNumber).toMatch(/^PO-/);
    expect(po.status).toBe('draft');
    expect(po.totalCents).toBe(4500000); // 45,000 LKR
    expect(po.items[0].totalCostCents).toBe(4500000);

    // Update status to sent
    const statusRes = await api('patch', `/api/inventory/purchase-orders/${po._id}/status`, shop.token).send({
      status: 'sent',
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.status).toBe('sent');
  });

  it('3. Non-serialised GRN on credit: updates stock, average cost, supplier bill, and ledger (Dr 1050 / Cr 2040)', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'USB-C Fast Cable',
      barcode: 'CABLE-USBC-01',
      costPriceCents: 50000,
      sellingPriceCents: 100000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Baseus LK',
      paymentTermsDays: 30,
    });
    const supplierId = supRes.body.data._id;

    // Post GRN on credit
    const grnRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'credit',
      items: [
        {
          productId,
          qty: 20,
          unitCostCents: 50000, // 500 LKR each = 10,000 LKR total (1000000 cents)
        },
      ],
      notes: 'Delivery received in good condition',
    });
    expect(grnRes.status).toBe(201);
    const { grn, bill } = grnRes.body.data;
    expect(grn.grnNumber).toMatch(/^GRN-/);
    expect(grn.totalAmountCents).toBe(1000000);
    expect(bill).toBeTruthy();
    expect(bill.status).toBe('unpaid');
    expect(bill.balanceCents).toBe(1000000);

    // Verify stock level updated
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const sl = await StockLevel.findOne({ productId, branchId: shop.branchId });
      expect(sl.qty).toBe(20);
      expect(sl.averageCostCents).toBe(50000);

      // Verify supplier balance
      const sup = await Supplier.findById(supplierId);
      expect(sup.currentBalanceCents).toBe(1000000);

      // Verify ledger journal: Dr 1050 / Cr 2040
      const entry = await LedgerEntry.findOne({ referenceId: grn.grnNumber });
      expect(entry).toBeTruthy();
      expect(entry.lines).toHaveLength(2);
      const drInv = entry.lines.find((e) => e.accountCode === '1050');
      const crAp = entry.lines.find((e) => e.accountCode === '2040');
      expect(drInv.debit).toBe(1000000);
      expect(drInv.credit).toBe(0);
      expect(crAp.debit).toBe(0);
      expect(crAp.credit).toBe(1000000);
    });
  });

  it('4. Serialised GRN with IMEI validation, rejection of duplicates & invalid Luhn', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Samsung Galaxy A15',
      barcode: 'SAM-A15-128',
      costPriceCents: 4500000,
      sellingPriceCents: 5500000,
      isSerialised: true,
    });
    const productId = prodRes.body.data._id;

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Samsung Authorized Distributor',
    });
    const supplierId = supRes.body.data._id;

    const imei1 = makeValidImei('35489009123456');
    const imei2 = makeValidImei('35489009123457');

    // Invalid Luhn rejected
    const badImeiRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'cash',
      items: [
        {
          productId,
          qty: 1,
          unitCostCents: 4500000,
          imeis: ['123456789012345'], // Not a valid Luhn IMEI
        },
      ],
    });
    expect(badImeiRes.status).toBe(400);

    // Duplicate in batch rejected
    const dupBatchRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'cash',
      items: [
        {
          productId,
          qty: 2,
          unitCostCents: 4500000,
          imeis: [imei1, imei1],
        },
      ],
    });
    expect(dupBatchRes.status).toBe(400);

    // Valid serialised GRN with immediate cash payment
    const validGrnRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'cash',
      items: [
        {
          productId,
          qty: 2,
          unitCostCents: 4500000,
          imeis: [imei1, imei2],
        },
      ],
    });
    expect(validGrnRes.status).toBe(201);
    const { grn, bill } = validGrnRes.body.data;
    expect(grn.totalAmountCents).toBe(9000000);
    expect(bill.status).toBe('paid');
    expect(bill.balanceCents).toBe(0);

    // Verify SerialUnits created with status in_stock
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const units = await SerialUnit.find({ productId });
      expect(units).toHaveLength(2);
      expect(units.map((u) => u.imei1)).toContain(imei1);
      expect(units[0].status).toBe('in_stock');

      // Verify Ledger journal for immediate cash GRN: Dr 1050 (Inventory) / Cr 1010 (Cash)
      const entry = await LedgerEntry.findOne({ referenceId: grn.grnNumber });
      expect(entry).toBeTruthy();
      expect(entry.lines).toHaveLength(2);
      const drInv = entry.lines.find((e) => e.accountCode === '1050');
      const crCash = entry.lines.find((e) => e.accountCode === '1010');
      expect(drInv.debit).toBe(9000000);
      expect(crCash.credit).toBe(9000000);
    });

    // Re-receiving already existing IMEI rejected
    const reReceiveRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'credit',
      items: [
        {
          productId,
          qty: 1,
          unitCostCents: 4500000,
          imeis: [imei1],
        },
      ],
    });
    expect(reReceiveRes.status).toBe(400);
  });

  it('5. Supplier Payment against bill reduces balance and posts to ledger (Dr 2040 / Cr 1010)', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Tempered Glass Screen Protector',
      barcode: 'GLASS-TG-01',
      costPriceCents: 15000,
      sellingPriceCents: 50000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Mobile Accessories Hub',
    });
    const supplierId = supRes.body.data._id;

    // Create GRN on credit for 50 units @ 15000 = 750000 cents (7,500 LKR)
    const grnRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'credit',
      items: [{ productId, qty: 50, unitCostCents: 15000 }],
    });
    const { bill } = grnRes.body.data;
    const billId = bill._id;

    // Make payment of 750000 cents via cash
    const payRes = await api('post', '/api/inventory/payments', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      billId,
      amountCents: 750000,
      paymentMethod: 'cash',
      reference: 'CHQ-8821',
      notes: 'Paid in full',
    });
    expect(payRes.status).toBe(201);
    expect(payRes.body.data.bill.status).toBe('paid');
    expect(payRes.body.data.bill.balanceCents).toBe(0);
    expect(payRes.body.data.supplierBalanceCents).toBe(0);

    // Verify ledger: Dr 2040 Accounts Payable / Cr 1010 Cash
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const payNumber = payRes.body.data.payment.paymentNumber;
      const entry = await LedgerEntry.findOne({ referenceId: payNumber });
      expect(entry).toBeTruthy();
      expect(entry.lines).toHaveLength(2);
      const drAp = entry.lines.find((e) => e.accountCode === '2040');
      const crCash = entry.lines.find((e) => e.accountCode === '1010');
      expect(drAp.debit).toBe(750000);
      expect(drAp.credit).toBe(0);
      expect(crCash.debit).toBe(0);
      expect(crCash.credit).toBe(750000);
    });
  });

  it('6. Purchase Return: reduces stock, sets IMEI status with_supplier, and credits AP (Dr 2040 / Cr 1050)', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Xiaomi Redmi Note 13',
      barcode: 'REDMI-N13-256',
      costPriceCents: 6000000,
      sellingPriceCents: 7200000,
      isSerialised: true,
    });
    const productId = prodRes.body.data._id;

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Xiaomi LK',
    });
    const supplierId = supRes.body.data._id;

    const testImei = makeValidImei('35899901456789');

    // Receive unit via GRN on credit
    const grnRes = await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'credit',
      items: [
        {
          productId,
          qty: 1,
          unitCostCents: 6000000,
          imeis: [testImei],
        },
      ],
    });
    const grnId = grnRes.body.data.grn._id;

    // Process Purchase Return
    const returnRes = await api('post', '/api/inventory/purchase-returns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      grnId,
      items: [
        {
          productId,
          qty: 1,
          unitCostCents: 6000000,
          imeis: [testImei],
          reason: 'Defective camera out of the box',
        },
      ],
      notes: 'Returning to supplier for credit/replacement',
    });
    expect(returnRes.status).toBe(201);
    const returnDoc = returnRes.body.data;
    expect(returnDoc.returnNumber).toMatch(/^PRT-/);
    expect(returnDoc.totalAmountCents).toBe(6000000);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      // Stock quantity reduced to 0
      const sl = await StockLevel.findOne({ productId, branchId: shop.branchId });
      expect(sl.qty).toBe(0);

      // SerialUnit status transitioned to with_supplier
      const unit = await SerialUnit.findOne({ imei1: testImei });
      expect(unit.status).toBe('with_supplier');

      // Supplier balance reduced back to 0
      const sup = await Supplier.findById(supplierId);
      expect(sup.currentBalanceCents).toBe(0);

      // Ledger entries: Dr 2040 Accounts Payable / Cr 1050 Inventory
      const entry = await LedgerEntry.findOne({ referenceId: returnDoc.returnNumber });
      expect(entry).toBeTruthy();
      expect(entry.lines).toHaveLength(2);
      const drAp = entry.lines.find((e) => e.accountCode === '2040');
      const crInv = entry.lines.find((e) => e.accountCode === '1050');
      expect(drAp.debit).toBe(6000000);
      expect(drAp.credit).toBe(0);
      expect(crInv.debit).toBe(0);
      expect(crInv.credit).toBe(6000000);
    });
  });

  it('7. Supplier Ageing and Payment Reminders', async () => {
    const shop = await setupShop();

    const supRes = await api('post', '/api/inventory/suppliers', shop.token).send({
      name: 'Sony Distributor',
    });
    const supplierId = supRes.body.data._id;

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Sony WH-1000XM5',
      barcode: 'SONY-XM5-BLK',
      costPriceCents: 8000000,
      sellingPriceCents: 9500000,
    });
    const productId = prodRes.body.data._id;

    // Create GRN on credit
    await api('post', '/api/inventory/grns', shop.token).send({
      branchId: shop.branchId,
      supplierId,
      paymentType: 'credit',
      items: [{ productId, qty: 1, unitCostCents: 8000000 }],
    });

    // Check ageing report
    const ageingRes = await api('get', `/api/inventory/bills/ageing?supplierId=${supplierId}`, shop.token);
    expect(ageingRes.status).toBe(200);
    expect(ageingRes.body.data.totalOutstandingCents).toBe(8000000);
    expect(ageingRes.body.data.currentCents).toBe(8000000);
    expect(ageingRes.body.data.bills).toHaveLength(1);

    // Trigger payment reminders
    const reminderRes = await api('post', '/api/inventory/bills/reminders', shop.token).send({
      daysAhead: 35,
    });
    expect(reminderRes.status).toBe(200);
    expect(reminderRes.body.data.count).toBe(1);
  });
});
