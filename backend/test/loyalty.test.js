import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import LoyaltyTransaction from '../src/modules/pos/models/LoyaltyTransaction.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupLoyaltyShop(email = 'loyalty-owner@shop.lk', name = 'Loyalty POS Shop') {
  const shop = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', shop.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0];

  await runWithContext({ tenantId }, async () => {
    await FakeStock.create([
      {
        branchId,
        barcode: 'BC-EARPHONES',
        name: 'Wireless Earphones',
        sellingPriceCents: 50000,
        costPriceCents: 30000,
        qty: 20,
      },
      {
        branchId,
        barcode: 'BC-PHONE-HIGH',
        name: 'Flagship Phone',
        sellingPriceCents: 1500000,
        costPriceCents: 1000000,
        qty: 10,
      },
    ]);
  });

  let customer;
  await runWithContext({ tenantId }, async () => {
    customer = await Customer.create({
      name: 'Sunil Perera',
      phone: '0719876543',
      nic: '198512345678',
      creditLimitCents: 5000000,
      currentBalanceCents: 0,
      loyaltyPoints: 0,
    });
  });

  return {
    ...shop,
    tenantId,
    branchId,
    customer,
  };
}

describe('Phase 8: Loyalty Points System (CRM-06)', () => {
  it('1. Accrues points on actual cash paid amount for customer sale', async () => {
    const shop = await setupLoyaltyShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [{ method: 'cash', amountCents: 50000 }],
    });

    expect(saleRes.status).toBe(201);
    expect(saleRes.body.data.invoiceNumber).toBeDefined();

    const cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(5);

    const txs = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LoyaltyTransaction.find({ customerId: shop.customer._id }).lean();
    });
    expect(txs.length).toBe(1);
    expect(txs[0].type).toBe('earn');
    expect(txs[0].points).toBe(5);
    expect(txs[0].amountCents).toBe(50000);
    expect(txs[0].balanceAfter).toBe(5);
  });

  it('2. Does NOT accrue points for walk-in customer', async () => {
    const shop = await setupLoyaltyShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [{ method: 'cash', amountCents: 50000 }],
    });

    expect(saleRes.status).toBe(201);

    const txs = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LoyaltyTransaction.find().lean();
    });
    expect(txs.length).toBe(0);
  });

  it('3. Earns points strictly on paid portion, NOT on unpaid credit balance', async () => {
    const shop = await setupLoyaltyShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-HIGH', qty: 1 }],
      payments: [
        { method: 'cash', amountCents: 500000 },
        { method: 'credit', amountCents: 1000000 },
      ],
      installmentPlan: {
        downPaymentCents: 500000,
        numberOfInstallments: 2,
      },
    });

    expect(saleRes.status).toBe(201);

    const cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(50);
  });

  it('4. Accrues loyalty points when installment or credit payment is subsequently collected', async () => {
    const shop = await setupLoyaltyShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-HIGH', qty: 1 }],
      payments: [{ method: 'credit', amountCents: 1500000 }],
      installmentPlan: {
        downPaymentCents: 0,
        numberOfInstallments: 3,
      },
    });
    expect(saleRes.status).toBe(201);

    let cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(0);

    const payRes = await api('post', '/api/pos/credit/payments', shop.token).send({
      customerId: shop.customer._id,
      amountCents: 500000,
      paymentMethod: 'cash',
      reference: 'RCP-001',
    });
    expect(payRes.status).toBe(201);

    cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(50);

    const tx = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LoyaltyTransaction.findOne({ customerId: shop.customer._id, type: 'installment_earn' }).lean();
    });
    expect(tx).toBeDefined();
    expect(tx.points).toBe(50);
    expect(tx.amountCents).toBe(500000);
  });

  it('5. Rejects points redemption below minimum threshold', async () => {
    const shop = await setupLoyaltyShop();

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await Customer.updateOne({ _id: shop.customer._id }, { loyaltyPoints: 80 });
    });

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [
        { method: 'loyalty_points', amountCents: 8000, reference: '80' },
        { method: 'cash', amountCents: 42000 },
      ],
    });

    expect(saleRes.status).toBe(400);
    expect(saleRes.body.message).toMatch(/Minimum 100 points required to redeem/i);
  });

  it('6. Rejects points redemption exceeding customer balance', async () => {
    const shop = await setupLoyaltyShop();

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await Customer.updateOne({ _id: shop.customer._id }, { loyaltyPoints: 120 });
    });

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [
        { method: 'loyalty_points', amountCents: 15000, reference: '150' },
        { method: 'cash', amountCents: 35000 },
      ],
    });

    expect(saleRes.status).toBe(400);
    expect(saleRes.body.message).toMatch(/Insufficient points balance/i);
  });

  it('7. Successfully redeems points, posts Debit 2030 in Ledger, and updates customer balance', async () => {
    const shop = await setupLoyaltyShop();

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await Customer.updateOne({ _id: shop.customer._id }, { loyaltyPoints: 200 });
    });

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [
        { method: 'loyalty_points', amountCents: 15000, reference: '150' },
        { method: 'cash', amountCents: 35000 },
      ],
    });

    if (saleRes.status !== 201) {
      console.log('TEST 7 ERROR:', saleRes.body);
    }
    expect(saleRes.status).toBe(201);

    const cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(53);

    const ledger = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find().lean();
    });

    const loyaltyDebit = ledger
      .flatMap((entry) => entry.lines)
      .find((line) => line.accountCode === '2030');

    expect(loyaltyDebit).toBeDefined();
    expect(loyaltyDebit.debit).toBe(15000);
    expect(loyaltyDebit.credit).toBe(0);
  });

  it('8. Reverses points originally earned on returned items', async () => {
    const shop = await setupLoyaltyShop();

    const saleRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-EARPHONES', qty: 1 }],
      payments: [{ method: 'cash', amountCents: 50000 }],
    });
    expect(saleRes.status).toBe(201);
    const invoice = saleRes.body.data;

    let cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(5);

    const returnRes = await api('post', '/api/pos/returns', shop.token).send({
      invoiceId: invoice._id,
      items: [
        {
          lineId: invoice.lines[0]._id,
          barcode: 'BC-EARPHONES',
          qty: 1,
          condition: 'Resellable',
          reason: 'Defective',
        },
      ],
      refundMethod: 'cash',
    });
    expect(returnRes.status).toBe(201);

    cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id).lean();
    });
    expect(cust.loyaltyPoints).toBe(0);

    const tx = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LoyaltyTransaction.findOne({ customerId: shop.customer._id, type: 'return_reversal' }).lean();
    });
    expect(tx).toBeDefined();
    expect(tx.points).toBe(-5);
  });

  it('9. Enforces multi-tenant isolation on loyalty points and transactions', async () => {
    const shop1 = await setupLoyaltyShop('shop1-loyalty@test.lk', 'Shop One');
    const shop2 = await setupLoyaltyShop('shop2-loyalty@test.lk', 'Shop Two');

    await runWithContext({ tenantId: shop1.tenantId }, async () => {
      await Customer.updateOne({ _id: shop1.customer._id }, { loyaltyPoints: 100 });
      await LoyaltyTransaction.create({
        tenantId: shop1.tenantId,
        customerId: shop1.customer._id,
        type: 'earn',
        points: 100,
        amountCents: 1000000,
        balanceAfter: 100,
      });
    });

    const historyRes = await api(
      'get',
      `/api/pos/loyalty/customer/${shop1.customer._id}`,
      shop2.token
    );
    expect(historyRes.status).toBe(404);

    const shop2Txs = await runWithContext({ tenantId: shop2.tenantId }, async () => {
      return await LoyaltyTransaction.find().lean();
    });
    expect(shop2Txs.length).toBe(0);
  });
});
