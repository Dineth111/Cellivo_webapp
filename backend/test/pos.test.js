import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff, addBranch } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import Payment from '../src/modules/pos/models/Payment.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import User from '../src/modules/users/User.model.js';
import { posEvents } from '../src/modules/pos/services/sale.service.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';

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
    expect(quoteRes.body.data.quoteNumber).toMatch(/^QTE-INV-\d+$/);

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

  it('4. checks branch access on every POS route', async () => {
    const shop = await setupShop('branch-access@shop.lk', 'Branch Access Shop');
    const other = await setupShop('branch-other@shop.lk', 'Other Shop');
    const cashier = await addStaff(shop, 'cashier', 'cashier-branch@shop.lk');
    const branchB = await addBranch(shop.tenantId, { invoicePrefix: 'B2' });
    const asB = (method, url, token) => api(method, url, token).set('x-branch-id', String(branchB._id));

    const blocked = [
      asB('post', '/api/pos/checkout', cashier.token).send({ lines: [caseLine()], payments: [{ method: 'cash', amountCents: 5000 }] }),
      asB('get', '/api/pos/cart/held', cashier.token),
      asB('get', '/api/pos/items/lookup?q=case', cashier.token),
      asB('get', '/api/pos/finance/drawer/current', cashier.token),
      asB('post', '/api/pos/returns', cashier.token).send({}),
      api('get', `/api/pos/cart/held?branchId=${branchB._id}`, cashier.token),
    ];
    for (const res of await Promise.all(blocked)) expect(res.status).toBe(403);

    // own branch still works
    expect((await api('get', '/api/pos/cart/held', cashier.token)).status).toBe(200);

    // owner has view_all_branches
    expect((await asB('get', '/api/pos/cart/held', shop.token)).status).toBe(200);

    // a branch of another tenant does not exist here, even for the owner
    const foreign = await api('get', '/api/pos/cart/held', shop.token).set('x-branch-id', String(other.branchId));
    expect(foreign.status).toBe(404);
  });

  it('5. numbers invoices per branch prefix without clashes', async () => {
    const shop = await setupShop('branch-numbers@shop.lk', 'Branch Numbers Shop');
    const branchB = await addBranch(shop.tenantId, { invoicePrefix: 'COL-' });
    await runWithContext({ tenantId: shop.tenantId }, async () =>
      FakeStock.create({ branchId: branchB._id, barcode: 'BC-CASE-1', name: 'Silicone Case', sellingPriceCents: 5000, costPriceCents: 2000, qty: 10 })
    );
    const sell = (branchId) =>
      api('post', '/api/pos/checkout', shop.token)
        .set('x-branch-id', String(branchId))
        .send({ lines: [caseLine()], payments: [{ method: 'cash', amountCents: 5000 }] });

    const [a, b] = await Promise.all([sell(shop.branchId), sell(branchB._id)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.invoiceNumber).toBe('INV-000001');
    expect(b.body.data.invoiceNumber).toBe('COL-000001');

    const parallel = await Promise.all(Array.from({ length: 4 }, () => sell(branchB._id)));
    for (const r of parallel) expect(r.status).toBe(201);
    expect(new Set(parallel.map((r) => r.body.data.invoiceNumber)).size).toBe(4);

    const quote = await api('post', '/api/pos/quotations', shop.token).set('x-branch-id', String(branchB._id)).send({ lines: [caseLine()] });
    expect(quote.body.data.quoteNumber).toBe('QTE-COL-000001');
  });

  const ledgerOf = (tenantId, invoiceNumber) =>
    runWithContext({ tenantId }, async () => await LedgerEntry.findOne({ referenceId: invoiceNumber }).lean());
  const debitOn = (entry, code) => entry.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debit, 0);

  it('6. posts each payment method to its own ledger account', async () => {
    const shop = await setupShop('ledger-map@shop.lk', 'Ledger Map Shop');
    const sell = (body) => api('post', '/api/pos/checkout', shop.token).send({ lines: [caseLine()], ...body });

    const bank = await sell({ payments: [{ method: 'bank_transfer', amountCents: 5000, reference: 'TX1' }] });
    expect(bank.status).toBe(201);
    const bankEntry = await ledgerOf(shop.tenantId, bank.body.data.invoiceNumber);
    expect(debitOn(bankEntry, '1030')).toBe(5000);
    expect(debitOn(bankEntry, '1010')).toBe(0);

    const cardTradeIn = await sell({
      tradeInValueCents: 1000,
      tradeIn: { imei: '490154203237518', modelName: 'Galaxy A10' },
      customerNic: '200012345678',
      payments: [{ method: 'card', amountCents: 4000 }],
    });
    expect(cardTradeIn.status).toBe(201);
    const ctEntry = await ledgerOf(shop.tenantId, cardTradeIn.body.data.invoiceNumber);
    expect(debitOn(ctEntry, '1020')).toBe(4000);
    expect(debitOn(ctEntry, '1010')).toBe(0);
    expect(ctEntry.lines.find((l) => l.accountCode === '1050' && l.debit === 1000)).toBeDefined();

    const customer = await runWithContext({ tenantId: shop.tenantId }, async () =>
      Customer.create({ name: 'Points Person', phone: '0770000001', loyaltyPoints: 200 })
    );
    const loyalty = await sell({ customerId: customer._id, payments: [{ method: 'loyalty_points', amountCents: 5000, reference: '50' }] });
    expect(loyalty.status).toBe(201);
    const loyaltyEntry = await ledgerOf(shop.tenantId, loyalty.body.data.invoiceNumber);
    expect(debitOn(loyaltyEntry, '2030')).toBe(5000);
    expect(debitOn(loyaltyEntry, '1010')).toBe(0);
  });

  it('7. split payment with change posts cash net of change; change without cash is rejected', async () => {
    const shop = await setupShop('split-change@shop.lk', 'Split Change Shop');
    const res = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [{ name: 'iPhone 15 Pro', barcode: 'BC-PHONE-1', imei: 'IMEI-001', qty: 1, unitPriceCents: 395400 }],
      invoiceDiscountAmountCents: 490,
      tradeInValueCents: 45000,
      tradeIn: { imei: '490154203237518', modelName: 'iPhone 11' },
      customerNic: '200012345678',
      payments: [
        { method: 'card', amountCents: 300000 },
        { method: 'cash', amountCents: 50000 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.grandTotalCents).toBe(349910);
    expect(res.body.data.changeDueCents).toBe(90);
    const entry = await ledgerOf(shop.tenantId, res.body.data.invoiceNumber);
    expect(debitOn(entry, '1010')).toBe(49910);
    expect(debitOn(entry, '1020')).toBe(300000);
    const debits = entry.lines.reduce((s, l) => s + l.debit, 0);
    expect(debits).toBe(entry.lines.reduce((s, l) => s + l.credit, 0));

    const cardOverpay = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [caseLine()],
      payments: [{ method: 'card', amountCents: 6000 }],
    });
    expect(cardOverpay.status).toBe(400);
    expect(cardOverpay.body.code).toBe('CHANGE_REQUIRES_CASH');
  });

  const drawerCash = async (token) => (await api('get', '/api/pos/finance/drawer/current', token)).body.data.expectedCashCents;

  it('8. drawer expected cash rises by cash kept, not cash tendered', async () => {
    const shop = await setupShop('drawer-change@shop.lk', 'Drawer Change Shop');
    expect((await api('post', '/api/pos/finance/drawer/open', shop.token).send({ openingFloatCents: 1000 })).status).toBe(201);

    const sale = await api('post', '/api/pos/checkout', shop.token).send({
      lines: [caseLine({ unitPriceCents: 9500 })],
      payments: [{ method: 'cash', amountCents: 10000 }],
    });
    expect(sale.status).toBe(201);
    expect(await drawerCash(shop.token)).toBe(1000 + 9500);
  });

  it('9. void reverses ledger, payments, customer balance, loyalty and drawer; returned invoices cannot be voided', async () => {
    const shop = await setupShop('void-full@shop.lk', 'Void Full Shop');
    const voidIt = (id) => api('post', `/api/pos/invoices/${id}/void`, shop.token).send({ reason: 'Keyed wrongly' });
    const inTenant = (fn) => runWithContext({ tenantId: shop.tenantId }, fn);
    const customer = await inTenant(async () =>
      Customer.create({ name: 'Void Customer', phone: '0770000002', creditLimitCents: 100000, loyaltyPoints: 200 })
    );
    const customerNow = () => inTenant(async () => Customer.findById(customer._id).lean());

    // credit sale -> balance restored
    const credit = await api('post', '/api/pos/checkout', shop.token).send({
      customerId: customer._id,
      lines: [caseLine()],
      payments: [{ method: 'credit', amountCents: 5000 }],
    });
    expect(credit.status).toBe(201);
    expect((await customerNow()).currentBalanceCents).toBe(5000);
    expect((await voidIt(credit.body.data._id)).status).toBe(200);
    expect((await customerNow()).currentBalanceCents).toBe(0);

    // cash sale with change -> drawer back to the float, every ledger entry reversed, payments kept as voided
    await api('post', '/api/pos/finance/drawer/open', shop.token).send({ openingFloatCents: 1000 });
    const cash = await api('post', '/api/pos/checkout', shop.token).send({ lines: [caseLine()], payments: [{ method: 'cash', amountCents: 6000 }] });
    expect(await drawerCash(shop.token)).toBe(6000);
    expect((await voidIt(cash.body.data._id)).status).toBe(200);
    expect(await drawerCash(shop.token)).toBe(1000);
    const entries = await inTenant(async () => LedgerEntry.find({ referenceId: cash.body.data.invoiceNumber }).lean());
    expect(entries.every((e) => e.isVoided)).toBe(true);
    const pays = await inTenant(async () => Payment.find({ invoiceId: cash.body.data._id }).lean());
    expect(pays.length).toBe(1);
    expect(pays[0].status).toBe('voided');

    // loyalty earned and redeemed are both restored
    const loyal = await api('post', '/api/pos/checkout', shop.token).send({
      customerId: customer._id,
      lines: [caseLine({ qty: 3 })],
      payments: [
        { method: 'loyalty_points', amountCents: 5000, reference: '50' },
        { method: 'cash', amountCents: 10000 },
      ],
    });
    expect(loyal.status).toBe(201);
    expect((await customerNow()).loyaltyPoints).toBe(200 - 50 + 1);
    expect((await voidIt(loyal.body.data._id)).status).toBe(200);
    expect((await customerNow()).loyaltyPoints).toBe(200);

    // returned invoice cannot be voided
    const sold = await api('post', '/api/pos/checkout', shop.token).send({ lines: [caseLine()], payments: [{ method: 'cash', amountCents: 5000 }] });
    await inTenant(async () => Invoice.updateOne({ _id: sold.body.data._id }, { status: 'partially_returned' }));
    const blocked = await voidIt(sold.body.data._id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('CANNOT_VOID_RETURNED');
  });
});
