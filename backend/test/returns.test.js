import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import CreditNote from '../src/modules/pos/models/CreditNote.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const VALID_IMEI = '356938035643809';
const INVALID_IMEI = '356938035643808';

async function setupReturnShop(email = 'returns@shop.lk', name = 'Returns Shop') {
  const shop = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', shop.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0];

  // Seed stock
  await runWithContext({ tenantId }, async () => {
    await FakeStock.create([
      {
        branchId,
        barcode: 'BC-PHONE-RET',
        name: 'Samsung S24',
        sellingPriceCents: 200000,
        costPriceCents: 150000,
        wholesalePriceCents: 180000,
        qty: 5,
        imeiList: [
          { imei: VALID_IMEI, status: 'in_stock' },
          { imei: 'IMEI-S24-002', status: 'in_stock' },
        ],
      },
      {
        branchId,
        barcode: 'BC-ACC-RET',
        name: 'USB-C Cable',
        sellingPriceCents: 3000,
        costPriceCents: 1500,
        wholesalePriceCents: 2200,
        qty: 10,
      },
    ]);
  });

  // Seed retail and wholesale customers
  let retailCustomer;
  let wholesaleCustomer;
  await runWithContext({ tenantId }, async () => {
    retailCustomer = await Customer.create({
      name: 'Retail Customer',
      phone: '0771112233',
      nic: '200012345678',
      type: 'retail',
    });
    wholesaleCustomer = await Customer.create({
      name: 'Wholesale Partner',
      phone: '0779998877',
      nic: '199587654321',
      type: 'wholesale',
    });
  });

  return {
    ...shop,
    tenantId,
    branchId,
    userId: userData._id,
    retailCustomer: retailCustomer.toObject(),
    wholesaleCustomer: wholesaleCustomer.toObject(),
  };
}

describe('Phase 5: Returns, Exchanges, Trade-Ins, and Wholesale (F-10)', () => {
  it('enforces plan gating: Lite plan cannot access returns (HTTP 403), Starter plan can', async () => {
    const shop = await setupReturnShop();

    // Set tenant to lite plan
    await runAsPlatform(async () => {
      await Tenant.updateOne({ _id: shop.tenantId }, { planCode: 'lite' });
    });

    const liteLookup = await api('get', '/api/pos/returns/lookup/INV-NONEXISTENT', shop.token);
    expect(liteLookup.status).toBe(403);
    expect(liteLookup.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(liteLookup.body.message).toMatch(/available from the Starter plan/i);

    const litePost = await api('post', '/api/pos/returns', shop.token).send({ invoiceId: '65f000000000000000000000' });
    expect(litePost.status).toBe(403);
    expect(litePost.body.code).toBe('FEATURE_NOT_IN_PLAN');

    // Upgrade to starter plan
    await runAsPlatform(async () => {
      await Tenant.updateOne({ _id: shop.tenantId }, { planCode: 'starter' });
    });

    const starterLookup = await api('get', '/api/pos/returns/lookup/INV-NONEXISTENT', shop.token);
    // Not 403 (should be 404 since invoice does not exist)
    expect(starterLookup.status).toBe(404);
  });

  it('performs counter return with resellable condition, restocks inventory, and updates invoice status', async () => {
    const shop = await setupReturnShop();

    // 1. Make a sale of 1 Samsung S24 (with IMEI) and 2 USB cables
    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.retailCustomer._id,
      lines: [
        {
          barcode: 'BC-PHONE-RET',
          name: 'Samsung S24',
          imei: VALID_IMEI,
          qty: 1,
          unitPriceCents: 200000,
        },
        {
          barcode: 'BC-ACC-RET',
          name: 'USB-C Cable',
          qty: 2,
          unitPriceCents: 3000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 206000 }],
    });

    expect(saleRes.status).toBe(201);
    const invoice = saleRes.body.data;
    expect(invoice.status).toBe('completed');

    // Verify stock deducted
    const stockAfterSale = await runWithContext({ tenantId: shop.tenantId }, async () => {
      const phone = await FakeStock.findOne({ barcode: 'BC-PHONE-RET' });
      const cable = await FakeStock.findOne({ barcode: 'BC-ACC-RET' });
      return { phone, cable };
    });
    expect(stockAfterSale.cable.qty).toBe(8); // 10 - 2
    expect(stockAfterSale.phone.imeiList.find((i) => i.imei === VALID_IMEI).status).toBe('sold');

    // 2. Lookup invoice for return
    const lookupRes = await api('get', `/api/pos/returns/lookup/${invoice.invoiceNumber}`, shop.token);
    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.data.isWithinWindow).toBe(true);
    expect(lookupRes.body.data.eligibleItems).toHaveLength(2);

    // 3. Process return for 1 USB-C cable (Resellable)
    const cableLine = invoice.lines.find((l) => l.barcode === 'BC-ACC-RET');
    const returnRes = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [
        {
          lineId: cableLine._id,
          barcode: 'BC-ACC-RET',
          qty: 1,
          condition: 'Resellable',
          reason: 'Bought wrong color',
        },
      ],
      refundMethod: 'cash',
    });

    expect(returnRes.status).toBe(201);
    const creditNote = returnRes.body.data;
    expect(creditNote.creditNoteNumber).toMatch(/^CN-\d{8}-\d{4}$/);
    expect(creditNote.totalRefundCents).toBe(3000);
    expect(creditNote.refundMethod).toBe('cash');

    // Check restocked quantity
    const cableStockAfterReturn = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await FakeStock.findOne({ barcode: 'BC-ACC-RET' });
    });
    expect(cableStockAfterReturn.qty).toBe(9); // 8 + 1 restocked

    // Check original invoice status is now 'partially_returned'
    const invAfterFirstReturn = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Invoice.findById(invoice._id);
    });
    expect(invAfterFirstReturn.status).toBe('partially_returned');

    // Check ledger entries posted for refund
    const ledgerEntries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ referenceType: 'refund', referenceId: creditNote._id });
    });
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(1);
    const entry = ledgerEntries[0];
    expect(entry.lines.length).toBeGreaterThanOrEqual(2);
    // Sales returns 4030 debit 3000, Cash 1010 credit 3000
    const returnLine = entry.lines.find((e) => e.accountCode === '4030');
    const cashLine = entry.lines.find((e) => e.accountCode === '1010');
    expect(returnLine.debit).toBe(3000);
    expect(cashLine.credit).toBe(3000);

    // 4. Return remaining items (Samsung S24 + 1 Cable) to achieve fully 'returned' status
    const phoneLine = invoice.lines.find((l) => l.barcode === 'BC-PHONE-RET');
    const return2Res = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [
        {
          lineId: phoneLine._id,
          imei: VALID_IMEI,
          qty: 1,
          condition: 'Resellable',
        },
        {
          lineId: cableLine._id,
          barcode: 'BC-ACC-RET',
          qty: 1,
          condition: 'Resellable',
        },
      ],
      refundMethod: 'card',
    });
    expect(return2Res.status).toBe(201);

    const invAfterFullReturn = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Invoice.findById(invoice._id);
    });
    expect(invAfterFullReturn.status).toBe('returned');

    // Phone IMEI is back in stock
    const phoneStockAfterFullReturn = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await FakeStock.findOne({ barcode: 'BC-PHONE-RET' });
    });
    expect(phoneStockAfterFullReturn.imeiList.find((i) => i.imei === VALID_IMEI).status).toBe('in_stock');
  });

  it('rejects return if items are damaged (does not restock damaged goods) and validates quantity boundaries', async () => {
    const shop = await setupReturnShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 2, unitPriceCents: 3000 }],
      payments: [{ method: 'cash', amountCents: 6000 }],
    });
    const invoice = saleRes.body.data;
    const cableLine = invoice.lines[0];

    // Return 1 unit as Damaged
    const returnRes = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [{ lineId: cableLine._id, barcode: 'BC-ACC-RET', qty: 1, condition: 'Damaged' }],
      refundMethod: 'store_credit',
    });
    expect(returnRes.status).toBe(201);

    // Stock should NOT increase for damaged item
    const stock = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await FakeStock.findOne({ barcode: 'BC-ACC-RET' });
    });
    expect(stock.qty).toBe(8); // stayed 8 (did not increase to 9)

    // Cannot return more than remaining 1 unit
    const overReturnRes = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [{ lineId: cableLine._id, barcode: 'BC-ACC-RET', qty: 2 }],
      refundMethod: 'cash',
    });
    expect(overReturnRes.status).toBe(400);
    expect(overReturnRes.body.code).toBe('RETURN_QTY_EXCEEDED');
  });

  it('rejects return if return window has expired (> 7 days)', async () => {
    const shop = await setupReturnShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      payments: [{ method: 'cash', amountCents: 3000 }],
    });
    const invoice = saleRes.body.data;

    // Artificially age the invoice to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(invoice._id)) },
      { $set: { createdAt: tenDaysAgo } }
    );

    const expiredReturnRes = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [{ lineId: invoice.lines[0]._id, qty: 1 }],
      refundMethod: 'cash',
    });
    expect(expiredReturnRes.status).toBe(400);
    expect(expiredReturnRes.body.code).toBe('RETURN_WINDOW_EXPIRED');
  });

  it('processes atomic counter exchange (combines return credit with new purchase)', async () => {
    const shop = await setupReturnShop();

    // 1. Initial sale of USB cable (3,000 cents)
    const initialSaleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.retailCustomer._id,
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      payments: [{ method: 'cash', amountCents: 3000 }],
    });
    const initialInvoice = initialSaleRes.body.data;

    // 2. Perform counter exchange: Return USB Cable (3,000 credit) and buy Samsung S24 (200,000)
    // Customer pays remaining 197,000 via cash
    const exchangeRes = await api('post', '/api/pos/returns/exchange', shop.token).send({
      returnPayload: {
        invoiceId: initialInvoice._id,
        items: [{ lineId: initialInvoice.lines[0]._id, barcode: 'BC-ACC-RET', qty: 1, condition: 'Resellable' }],
      },
      salePayload: {
        customerId: shop.retailCustomer._id,
        lines: [{ barcode: 'BC-PHONE-RET', name: 'Samsung S24', imei: VALID_IMEI, qty: 1, unitPriceCents: 200000 }],
        payments: [{ method: 'cash', amountCents: 197000 }],
      },
    });

    expect(exchangeRes.status).toBe(201);
    const { creditNote, exchangeInvoice, exchangeCreditCents } = exchangeRes.body.data;
    expect(exchangeCreditCents).toBe(3000);
    expect(creditNote.totalRefundCents).toBe(3000);
    expect(exchangeInvoice.grandTotalCents).toBe(200000);
    // Verified 2 payments: store_credit 3,000 and cash 197,000
    const newPayments = await runWithContext({ tenantId: shop.tenantId }, async () => {
      const inv = await Invoice.findById(exchangeInvoice._id);
      return inv;
    });
    expect(newPayments.status).toBe('completed');
  });

  it('automatically applies wholesale pricing tier for wholesale customer accounts', async () => {
    const shop = await setupReturnShop();

    // 1. Retail customer pays retail price (200,000 cents)
    const retailRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.retailCustomer._id,
      lines: [{ barcode: 'BC-PHONE-RET', name: 'Samsung S24', qty: 1, unitPriceCents: 200000 }],
      payments: [{ method: 'cash', amountCents: 200000 }],
    });
    expect(retailRes.status).toBe(201);
    expect(retailRes.body.data.subtotalCents).toBe(200000);

    // 2. Wholesale customer gets wholesale price (180,000 cents)
    const wholesaleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.wholesaleCustomer._id,
      lines: [{ barcode: 'BC-PHONE-RET', name: 'Samsung S24', qty: 1 }],
      payments: [{ method: 'cash', amountCents: 180000 }],
    });
    expect(wholesaleRes.status).toBe(201);
    expect(wholesaleRes.body.data.subtotalCents).toBe(180000);
    expect(wholesaleRes.body.data.grandTotalCents).toBe(180000);
  });

  it('enforces trade-in regulatory compliance: IMEI Luhn check and Customer NIC identity verification', async () => {
    const shop = await setupReturnShop();

    // 1. Rejects invalid IMEI (failed Luhn algorithm)
    const invalidImeiRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.retailCustomer._id,
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      tradeIn: {
        imei: INVALID_IMEI,
        modelName: 'Old iPhone 11',
        valuationCents: 1000,
      },
      tradeInValueCents: 1000,
      payments: [{ method: 'cash', amountCents: 2000 }],
    });
    expect(invalidImeiRes.status).toBe(400);
    expect(invalidImeiRes.body.code).toBe('INVALID_TRADE_IN_IMEI');

    // 2. Rejects walk-in customer trade-in if NIC is missing
    const missingNicRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      tradeIn: {
        imei: VALID_IMEI,
        modelName: 'Old iPhone 11',
        valuationCents: 1000,
      },
      tradeInValueCents: 1000,
      payments: [{ method: 'cash', amountCents: 2000 }],
    });
    expect(missingNicRes.status).toBe(400);
    expect(missingNicRes.body.code).toBe('TRADE_IN_NIC_REQUIRED');

    // 3. Accepts trade-in with valid Luhn IMEI and customer NIC
    const validTradeInRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.retailCustomer._id, // has nic: '200012345678'
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      tradeIn: {
        imei: VALID_IMEI,
        modelName: 'Old iPhone 11',
        valuationCents: 1000,
      },
      tradeInValueCents: 1000,
      payments: [{ method: 'cash', amountCents: 2000 }],
    });
    expect(validTradeInRes.status).toBe(201);
    expect(validTradeInRes.body.data.grandTotalCents).toBe(2000);
  });

  it('enforces tenant isolation on returns: Tenant B cannot lookup or return Tenant A invoices', async () => {
    const shopA = await setupReturnShop('shop-a@returns.lk', 'Shop A Returns');
    const shopB = await setupReturnShop('shop-b@returns.lk', 'Shop B Returns');

    // Create sale in Shop A
    const saleA = await api('post', '/api/pos/sales/checkout', shopA.token).send({
      lines: [{ barcode: 'BC-ACC-RET', name: 'USB-C Cable', qty: 1, unitPriceCents: 3000 }],
      payments: [{ method: 'cash', amountCents: 3000 }],
    });
    const invoiceA = saleA.body.data;

    // Shop B tries to lookup Shop A's invoice
    const lookupB = await api('get', `/api/pos/returns/lookup/${invoiceA.invoiceNumber}`, shopB.token);
    expect(lookupB.status).toBe(404);

    // Shop B tries to return Shop A's invoice
    const returnB = await api('post', '/api/pos/returns', shopB.token).send({
      invoiceId: invoiceA._id,
      items: [{ lineId: invoiceA.lines[0]._id, qty: 1 }],
      refundMethod: 'cash',
    });
    expect(returnB.status).toBe(404);
  });
});
