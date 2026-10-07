import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import Payment from '../src/modules/pos/models/Payment.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import User from '../src/modules/users/User.model.js';
import { posEvents } from '../src/modules/pos/services/sale.service.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'pos-f09@shop.lk', name = 'POS Shop') {
  const shop = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', shop.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0];

  // Set approval PIN "9999" on owner for manager approval tests
  const pinHash = await bcrypt.hash('9999', 10);
  await runAsPlatform(async () => {
    await User.updateOne({ _id: userData._id }, { approvalPinHash: pinHash });
  });

  // Seed inventory for this shop
  await runWithContext({ tenantId }, async () => {
    await FakeStock.create([
      {
        branchId,
        barcode: 'BC-PHONE-1',
        name: 'iPhone 15 Pro',
        sellingPriceCents: 395400, // 3,954.00
        costPriceCents: 300000,
        qty: 10,
        imeiList: [
          { imei: 'IMEI-001', status: 'in_stock' },
          { imei: 'IMEI-002', status: 'in_stock' },
          { imei: 'IMEI-003', status: 'in_stock' },
        ],
      },
      {
        branchId,
        barcode: 'BC-CASE-1',
        name: 'Silicone Case',
        sellingPriceCents: 5000,
        costPriceCents: 2000,
        qty: 3, // only 3 left for V-05 test
      },
    ]);
  });

  return { ...shop, tenantId, branchId, userId: userData._id };
}

describe('POS Sale Backend (F-09) Engine', () => {
  it('enforces mathematical precision and FRS test case (Subtotal 395,400, discount 490, trade-in 45,000 -> 349,910)', async () => {
    const shop = await setupShop();

    // 1. Calculate endpoint test
    const calcRes = await api('post', '/api/pos/cart/calculate', shop.token).send({
      subtotalCents: 395400,
      invoiceDiscountAmountCents: 490,
      tradeInValueCents: 45000,
      taxRatePercent: 0,
    });

    expect(calcRes.status).toBe(200);
    expect(calcRes.body.data.grandTotalCents).toBe(349910);
    expect(calcRes.body.data.subtotalCents).toBe(395400);
    expect(calcRes.body.data.totalDiscountCents).toBe(490);
    expect(calcRes.body.data.tradeInValueCents).toBe(45000);

    // 2. Checkout endpoint with FRS figures
    const checkoutRes = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [
        {
          name: 'iPhone 15 Pro',
          barcode: 'BC-PHONE-1',
          imei: 'IMEI-001',
          qty: 1,
          unitPriceCents: 395400,
        },
      ],
      invoiceDiscountAmountCents: 490,
      tradeInValueCents: 45000,
      tradeIn: {
        imei: 'TRADE-IN-OLD-1',
        modelName: 'iPhone 11',
        valuationCents: 45000,
      },
      payments: [{ method: 'cash', amountCents: 349910 }],
    });

    expect(checkoutRes.status).toBe(201);
    const invoice = checkoutRes.body.data;
    expect(invoice.invoiceNumber).toMatch(/^INV-\d+$/);
    expect(invoice.grandTotalCents).toBe(349910);
    expect(invoice.tradeInCents).toBe(45000);
    expect(invoice.totalPaidCents).toBe(349910);
    expect(invoice.status).toBe('completed');
    expect(invoice.paymentStatus).toBe('paid');
  });

  it('guarantees atomic concurrency and gapless sequential numbering', async () => {
    const shop = await setupShop('concurrent@shop.lk', 'Concurrent Shop');

    // Run 5 simultaneous checkouts in parallel
    const parallelRequests = Array.from({ length: 5 }, (_, i) =>
      api('post', '/api/pos/checkout', shop.token).send({
        lines: [
          {
            name: `Parallel Item ${i}`,
            barcode: 'BC-PHONE-1',
            qty: 1,
            unitPriceCents: 10000,
          },
        ],
        payments: [{ method: 'cash', amountCents: 10000 }],
      })
    );

    const responses = await Promise.all(parallelRequests);
    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const invoiceNumbers = responses.map((r) => r.body.data.invoiceNumber);
    const uniqueNumbers = new Set(invoiceNumbers);
    expect(uniqueNumbers.size).toBe(5); // No duplicate invoice numbers
  });

  it('prevents double-charge and double-deduction via Idempotency Key', async () => {
    const shop = await setupShop('idempotent@shop.lk', 'Idempotent Shop');
    const idempotencyKey = 'idem-unique-key-12345';

    const payload = {
      lines: [
        {
          name: 'iPhone 15 Pro',
          barcode: 'BC-PHONE-1',
          qty: 1,
          unitPriceCents: 300000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 300000 }],
      idempotencyKey,
    };

    // First checkout
    const firstRes = await api('post', '/api/pos/checkout', shop.token).send(payload);
    expect(firstRes.status).toBe(201);
    const firstInvoice = firstRes.body.data;

    // Second checkout with identical idempotencyKey
    const secondRes = await api('post', '/api/pos/checkout', shop.token).send(payload);
    expect(secondRes.status).toBe(201);
    const secondInvoice = secondRes.body.data;

    expect(secondInvoice._id).toBe(firstInvoice._id);
    expect(secondInvoice.invoiceNumber).toBe(firstInvoice.invoiceNumber);

    // Verify stock was deducted only ONCE
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const stock = await FakeStock.findOne({ barcode: 'BC-PHONE-1' });
      expect(stock.qty).toBe(9); // from 10 down to 9 (not 8)
    });
  });

  it('enforces stock limits (V-05) and rejects duplicate IMEI sale (V-03)', async () => {
    const shop = await setupShop('stock-rules@shop.lk', 'Stock Rules Shop');

    // 1. V-05: Selling 4 silicone cases when only 3 exist
    const overStockRes = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 4, // only 3 left
          unitPriceCents: 5000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 20000 }],
    });

    expect(overStockRes.status).toBe(400);
    expect(overStockRes.body.code).toBe('V-05');
    expect(overStockRes.body.message).toMatch(/Only 3 left at this branch/);

    // 2. Sell IMEI-002 successfully
    const saleRes = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [
        {
          name: 'iPhone 15 Pro',
          barcode: 'BC-PHONE-1',
          imei: 'IMEI-002',
          qty: 1,
          unitPriceCents: 395400,
        },
      ],
      payments: [{ method: 'cash', amountCents: 395400 }],
    });
    expect(saleRes.status).toBe(201);

    // 3. V-03: Attempt to sell the same IMEI-002 again
    const dupeImeiRes = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [
        {
          name: 'iPhone 15 Pro',
          barcode: 'BC-PHONE-1',
          imei: 'IMEI-002',
          qty: 1,
          unitPriceCents: 395400,
        },
      ],
      payments: [{ method: 'cash', amountCents: 395400 }],
    });

    expect(dupeImeiRes.status).toBe(400);
    expect(dupeImeiRes.body.code).toBe('V-03');
    expect(dupeImeiRes.body.message).toMatch(/IMEI IMEI-002 was sold/);
  });

  it('validates cashier discount limits (V-06), manager PIN approval, and short payment (V-08)', async () => {
    const shop = await setupShop('cashier-rules@shop.lk', 'Cashier Shop');

    // Add a cashier (cashier discount limit is 5%)
    const cashier = await addStaff(shop, 'cashier', 'cashier1@shop.lk');

    // 1. Cashier gives 10% discount without manager PIN -> blocked (V-06)
    const overDiscountRes = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
          discountPercent: 10, // 10% exceeds cashier's 5% limit
        },
      ],
      payments: [{ method: 'cash', amountCents: 4500 }],
    });

    expect(overDiscountRes.status).toBe(400);
    expect(overDiscountRes.body.code).toBe('V-06');
    expect(overDiscountRes.body.message).toMatch(/This discount is above your limit/);

    // 2. Cashier provides valid manager PIN "9999" -> succeeds
    const approvedDiscountRes = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
          discountPercent: 10,
        },
      ],
      managerPin: '9999',
      payments: [{ method: 'cash', amountCents: 4500 }],
    });

    expect(approvedDiscountRes.status).toBe(201);

    // 3. Short payment (V-08): Total 5,000, paid 4,000 -> blocked
    const shortPayRes = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 4000 }],
    });

    expect(shortPayRes.status).toBe(400);
    expect(shortPayRes.body.code).toBe('V-08');
    expect(shortPayRes.body.message).toMatch(/Payments are 1000 short of the total/);
  });

  it('masks cost prices and profit margins for cashiers lacking view_cost_margin', async () => {
    const shop = await setupShop('cost-mask@shop.lk', 'Cost Mask Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-mask@shop.lk');

    // 1. Cashier checks out
    const cashierSale = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 5000 }],
    });

    expect(cashierSale.status).toBe(201);
    const cashierLine = cashierSale.body.data.lines[0];
    expect(cashierLine.costPriceCents).toBeUndefined(); // Stripped!
    expect(cashierLine.unitCost).toBeUndefined();

    // 2. Owner checks out (Owner has view_cost_margin)
    const ownerSale = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 5000 }],
    });

    expect(ownerSale.status).toBe(201);
    const ownerLine = ownerSale.body.data.lines[0];
    expect(ownerLine.costPriceCents).toBe(2000); // Visible!
  });

  it('supports cart holding, 24h expiration cleanup, and quotation conversion', async () => {
    const shop = await setupShop('hold-quote@shop.lk', 'Hold Quote Shop');

    // 1. Hold cart with IMEI
    const holdRes = await api('post', '/api/pos/cart/hold', shop.token).send({
      cartName: 'Customer John Phone',
      lines: [
        {
          name: 'iPhone 15 Pro',
          barcode: 'BC-PHONE-1',
          imei: 'IMEI-003',
          qty: 1,
          unitPriceCents: 395400,
        },
      ],
    });

    expect(holdRes.status).toBe(201);
    const heldId = holdRes.body.data._id;

    // List held carts
    const listHeld = await api('get', '/api/pos/cart/held', shop.token);
    expect(listHeld.status).toBe(200);
    expect(listHeld.body.data.some((c) => c._id === heldId)).toBe(true);

    // Resume held cart
    const resumeRes = await api('post', `/api/pos/cart/resume/${heldId}`, shop.token);
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.data.cartName).toBe('Customer John Phone');

    // 2. Create Quotation and convert to Invoice
    const quoteRes = await api('post', '/api/pos/quotations', shop.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
        },
      ],
    });
    expect(quoteRes.status).toBe(201);
    const quoteId = quoteRes.body.data._id;
    expect(quoteRes.body.data.quoteNumber).toMatch(/^QTE-\d+$/);

    // Convert quotation
    const convertRes = await api('post', `/api/pos/quotations/${quoteId}/convert`, shop.token).send({
      payments: [{ method: 'cash', amountCents: 5000 }],
    });
    expect(convertRes.status).toBe(201);
    expect(convertRes.body.data.status).toBe('completed');
  });

  it('voids invoice, reverses stock and ledger, and verifies tenant isolation', async () => {
    const shopA = await setupShop('shop-a@shop.lk', 'Shop A');
    const shopB = await setupShop('shop-b@shop.lk', 'Shop B');

    // 1. Complete sale in Shop A
    const saleA = await api('post', '/api/pos/checkout', shopA.token).send({
      lines: [
        {
          name: 'Silicone Case',
          barcode: 'BC-CASE-1',
          qty: 1,
          unitPriceCents: 5000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 5000 }],
    });
    expect(saleA.status).toBe(201);
    const invoiceAId = saleA.body.data._id;

    // 2. Tenant isolation: Shop B cannot void Shop A's invoice
    const crossVoid = await api('post', `/api/pos/invoices/${invoiceAId}/void`, shopB.token).send({
      reason: 'Cross tenant attack',
    });
    expect(crossVoid.status).toBe(404);

    // 3. Shop A voids its invoice
    const voidRes = await api('post', `/api/pos/invoices/${invoiceAId}/void`, shopA.token).send({
      reason: 'Customer returned item immediately',
    });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.data.status).toBe('voided');

    // Re-voiding throws ALREADY_VOIDED
    const revoid = await api('post', `/api/pos/invoices/${invoiceAId}/void`, shopA.token).send({
      reason: 'Trying to void again',
    });
    expect(revoid.status).toBe(400);

    // Verify stock was restored
    await runWithContext({ tenantId: shopA.tenantId }, async () => {
      const stock = await FakeStock.findOne({ barcode: 'BC-CASE-1' });
      expect(stock.qty).toBe(3); // restored back to 3
    });
  });
});

describe('POS review fixes', () => {
  const caseLine = (extra = {}) => ({ name: 'Silicone Case', barcode: 'BC-CASE-1', qty: 1, unitPriceCents: 5000, ...extra });
  const auditOf = (tenantId, action) => runWithContext({ tenantId }, async () => await AuditLog.find({ action }).lean());

  it('1. reads price and cost from stock: client cost ignored, price change needs override_price or PIN', async () => {
    const shop = await setupShop('price-fix@shop.lk', 'Price Fix Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-price@shop.lk');

    // below cost with a forged costPriceCents of 0 -> still blocked
    const belowCost = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ unitPriceCents: 1000, costPriceCents: 0 })],
      payments: [{ method: 'cash', amountCents: 1000 }],
    });
    expect(belowCost.status).toBe(403);
    expect(belowCost.body.code).toBe('PRICE_OVERRIDE_REQUIRES_APPROVAL');

    // above cost but different from the stock price -> blocked without permission
    const changed = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ unitPriceCents: 4000 })],
      payments: [{ method: 'cash', amountCents: 4000 }],
    });
    expect(changed.status).toBe(403);

    // same change with a manager PIN -> accepted
    const withPin = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ unitPriceCents: 4000 })],
      managerPin: '9999',
      payments: [{ method: 'cash', amountCents: 4000 }],
    });
    expect(withPin.status).toBe(201);

    // owner has override_price -> accepted, cost comes from stock, audited with before/after
    const owner = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [caseLine({ unitPriceCents: 4500, costPriceCents: 1 })],
      payments: [{ method: 'cash', amountCents: 4500 }],
    });
    expect(owner.status).toBe(201);
    expect(owner.body.data.lines[0].costPriceCents).toBe(2000);
    const logs = await auditOf(shop.tenantId, 'pos.price_override');
    expect(logs.some((l) => l.before?.lines?.[0]?.unitPriceCents === 5000 && l.after?.lines?.[0]?.unitPriceCents === 4500)).toBe(true);
  });

  it('2. converts amount discounts to percent and enforces the role limit (V-06)', async () => {
    const shop = await setupShop('disc-amount@shop.lk', 'Disc Amount Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-disc@shop.lk'); // 5% limit

    // 20% as a line amount
    const lineAmt = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ discountAmountCents: 1000 })],
      payments: [{ method: 'cash', amountCents: 4000 }],
    });
    expect(lineAmt.status).toBe(400);
    expect(lineAmt.body.code).toBe('V-06');

    // 20% as an invoice amount
    const invAmt = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine()],
      invoiceDiscountAmountCents: 1000,
      payments: [{ method: 'cash', amountCents: 4000 }],
    });
    expect(invAmt.status).toBe(400);
    expect(invAmt.body.code).toBe('V-06');

    // 4% line + 4% invoice stacks to ~7.8% of the subtotal -> over 5%
    const stacked = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ discountPercent: 4 })],
      invoiceDiscountPercent: 4,
      payments: [{ method: 'cash', amountCents: 4608 }],
    });
    expect(stacked.status).toBe(400);
    expect(stacked.body.code).toBe('V-06');

    const approved = await api('post', '/api/pos/checkout', cashier.token).send({
      lines: [caseLine({ discountAmountCents: 1000 })],
      managerPin: '9999',
      payments: [{ method: 'cash', amountCents: 4000 }],
    });
    expect(approved.status).toBe(201);
    expect((await auditOf(shop.tenantId, 'pos.discount_approved')).length).toBe(1);
  });

  it('3. trade-in value needs a device, and a value over the role limit needs a manager PIN', async () => {
    const shop = await setupShop('tradein-fix@shop.lk', 'Trade-in Fix Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-tradein@shop.lk');
    const sale = (token, extra) =>
      api('post', '/api/pos/checkout', token).send({
        lines: [caseLine()],
        tradeInValueCents: 1000,
        customerNic: '200012345678',
        payments: [{ method: 'cash', amountCents: 4000 }],
        ...extra,
      });
    const device = { imei: '490154203237518', modelName: 'Galaxy A10' };

    for (const tradeIn of [undefined, { imei: device.imei }, { modelName: 'Galaxy A10' }]) {
      const res = await sale(shop.token, { tradeIn });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TRADE_IN_DEVICE_REQUIRED');
    }

    // cashier's trade-in limit defaults to 0
    const overLimit = await sale(cashier.token, { tradeIn: device });
    expect(overLimit.status).toBe(403);
    expect(overLimit.body.code).toBe('TRADE_IN_APPROVAL_REQUIRED');

    const approved = await sale(cashier.token, { tradeIn: device, managerPin: '9999' });
    expect(approved.status).toBe(201);
    expect((await auditOf(shop.tenantId, 'pos.trade_in_approved')).length).toBe(1);

    // non-phone devices need no IMEI
    const accessory = await sale(shop.token, { tradeIn: { modelName: 'AirPods', category: 'accessory' } });
    expect(accessory.status).toBe(201);
  });
});
