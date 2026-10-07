import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import User from '../src/modules/users/User.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import InstallmentPlan from '../src/modules/pos/models/InstallmentPlan.model.js';
import * as creditService from '../src/modules/pos/services/credit.service.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupCreditShop(email = 'credit-owner@shop.lk', name = 'Credit Shop') {
  const shop = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', shop.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0];

  // Set manager approval PIN "9999" on owner
  const pinHash = await bcrypt.hash('9999', 10);
  await runAsPlatform(async () => {
    await User.updateOne({ _id: userData._id }, { approvalPinHash: pinHash });
  });

  // Seed stock
  await runWithContext({ tenantId }, async () => {
    await FakeStock.create([
      {
        branchId,
        barcode: 'BC-PHONE-CREDIT',
        name: 'iPhone 15',
        sellingPriceCents: 300000, // 3,000.00
        costPriceCents: 220000,
        qty: 10,
      },
    ]);
  });

  // Seed customer with creditLimit 200,000 cents
  let customer;
  await runWithContext({ tenantId }, async () => {
    customer = await Customer.create({
      name: 'Nimal Perera',
      phone: '0771234567',
      nic: '199012345678',
      creditLimitCents: 200000,
      currentBalanceCents: 0,
    });
  });

  return {
    ...shop,
    tenantId,
    branchId,
    userId: userData._id,
    customer: customer.toObject(),
  };
}

describe('Phase 6: Credit and Installments (F-11, POS-09, CRM-03 to CRM-05)', () => {
  it('enforces plan gating: Lite plan cannot access credit/installments (HTTP 403), Starter plan can', async () => {
    const shop = await setupCreditShop();

    // Set tenant to lite plan
    await runAsPlatform(async () => {
      await Tenant.updateOne({ _id: shop.tenantId }, { planCode: 'lite' });
    });

    const liteRes = await api('get', `/api/pos/credit/customers/${shop.customer._id}/eligibility`, shop.token);
    expect(liteRes.status).toBe(403);
    expect(liteRes.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(liteRes.body.message).toMatch(/credit/i);

    // Set tenant back to starter plan
    await runAsPlatform(async () => {
      await Tenant.updateOne({ _id: shop.tenantId }, { planCode: 'starter' });
    });

    const starterRes = await api('get', `/api/pos/credit/customers/${shop.customer._id}/eligibility`, shop.token);
    expect(starterRes.status).toBe(200);
    expect(starterRes.body.data.creditLimitCents).toBe(200000);
  });

  it('strictly blocks credit sales or installment plans for Walk-in customers', async () => {
    const shop = await setupCreditShop();

    const walkInCreditRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      payments: [{ method: 'credit', amountCents: 300000 }],
    });

    expect(walkInCreditRes.status).toBe(400);
    expect(walkInCreditRes.body.code).toBe('CREDIT_REQUIRES_CUSTOMER');

    const walkInInstallmentRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      installmentPlan: {
        downPaymentCents: 50000,
        numberOfInstallments: 3,
        frequency: 'monthly',
      },
      payments: [{ method: 'cash', amountCents: 50000 }],
    });

    expect(walkInInstallmentRes.status).toBe(400);
    expect(walkInInstallmentRes.body.code).toBe('CREDIT_REQUIRES_CUSTOMER');
  });

  it('enforces credit limit and overdue exposure (V-07), requiring manager PIN if exceeded', async () => {
    const shop = await setupCreditShop();

    // Customer credit limit is 200,000 cents.
    // Sale total is 300,000 cents on credit -> exceeds limit by 100,000 cents.
    const exceedRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      payments: [{ method: 'credit', amountCents: 300000 }],
    });

    expect(exceedRes.status).toBe(400);
    expect(exceedRes.body.code).toBe('V-07');
    expect(exceedRes.body.message).toMatch(/Nimal Perera would go over their credit limit by Rs 1,000\.00\. Take a payment or ask a manager to approve\./);

    // Provide invalid manager PIN -> still blocked
    const badPinRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      payments: [{ method: 'credit', amountCents: 300000 }],
      managerPin: '0000',
    });
    expect(badPinRes.status).toBe(400);
    expect(badPinRes.body.code).toBe('V-07');

    // Provide valid manager PIN "9999" -> authorized and completed
    const approvedRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      payments: [{ method: 'credit', amountCents: 300000 }],
      managerPin: '9999',
    });

    expect(approvedRes.status).toBe(201);
    expect(approvedRes.body.data.grandTotalCents).toBe(300000);
    expect(approvedRes.body.data.paymentStatus).toBe('unpaid');

    // Customer balance updated to 300,000
    const updatedCust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id);
    });
    expect(updatedCust.currentBalanceCents).toBe(300000);
  });

  it('generates exact integer cent installment schedules without fractional loss', () => {
    // 100,000 cents financed across 3 installments
    // 100,000 / 3 = 33,333 base, remainder 1 -> installment 1 gets 33,334, installments 2 & 3 get 33,333
    const schedule3 = creditService.calculateSchedule({
      financedAmountCents: 100000,
      numberOfInstallments: 3,
      frequency: 'monthly',
      firstDueDate: new Date('2026-04-01T00:00:00.000Z'),
    });

    expect(schedule3).toHaveLength(3);
    expect(schedule3[0].amountCents).toBe(33334);
    expect(schedule3[1].amountCents).toBe(33333);
    expect(schedule3[2].amountCents).toBe(33333);

    const sum = schedule3.reduce((acc, s) => acc + s.amountCents, 0);
    expect(sum).toBe(100000);

    // Verify dates
    expect(new Date(schedule3[0].dueDate).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(new Date(schedule3[1].dueDate).toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(new Date(schedule3[2].dueDate).toISOString().slice(0, 10)).toBe('2026-06-01');

    // Weekly schedule
    const scheduleWeekly = creditService.calculateSchedule({
      financedAmountCents: 70000,
      numberOfInstallments: 4,
      frequency: 'weekly',
      firstDueDate: new Date('2026-04-01T00:00:00.000Z'),
    });
    expect(scheduleWeekly).toHaveLength(4);
    expect(new Date(scheduleWeekly[0].dueDate).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(new Date(scheduleWeekly[1].dueDate).toISOString().slice(0, 10)).toBe('2026-04-08');
  });

  it('creates an installment plan during checkout and records down payment', async () => {
    const shop = await setupCreditShop();

    // Total 300,000, Down payment 150,000, Financed 150,000 across 3 installments
    // Financed 150,000 <= creditLimit 200,000 -> succeeds without PIN
    const checkoutRes = await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      installmentPlan: {
        downPaymentCents: 150000,
        numberOfInstallments: 3,
        frequency: 'monthly',
        firstDueDate: '2026-05-01',
      },
      payments: [{ method: 'cash', amountCents: 150000 }],
    });

    expect(checkoutRes.status).toBe(201);
    const invoice = checkoutRes.body.data;
    expect(invoice.paymentStatus).toBe('partially_paid');
    expect(invoice.totalPaidCents).toBe(150000);
    expect(invoice.installmentPlanId).toBeTruthy();

    // Verify InstallmentPlan document
    const plan = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await InstallmentPlan.findById(invoice.installmentPlanId);
    });
    expect(plan.planNumber).toMatch(/^IP-\d{8}-\d{4}$/);
    expect(plan.financedAmountCents).toBe(150000);
    expect(plan.remainingBalanceCents).toBe(150000);
    expect(plan.schedule).toHaveLength(3);
    expect(plan.schedule[0].amountCents).toBe(50000);
    expect(plan.schedule[1].amountCents).toBe(50000);
    expect(plan.schedule[2].amountCents).toBe(50000);

    // Verify Customer balance updated to 150,000
    const cust = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(shop.customer._id);
    });
    expect(cust.currentBalanceCents).toBe(150000);
  });

  it('allocates collections payments to the oldest-due installments first and posts to ledger', async () => {
    const shop = await setupCreditShop();

    // 1. Create installment sale with 3 installments of 50,000 each (due 2026-04-01, 2026-05-01, 2026-06-01)
    await api('post', '/api/pos/sales/checkout', shop.token).send({
      customerId: shop.customer._id,
      lines: [{ barcode: 'BC-PHONE-CREDIT', name: 'iPhone 15', qty: 1, unitPriceCents: 300000 }],
      installmentPlan: {
        downPaymentCents: 150000,
        numberOfInstallments: 3,
        frequency: 'monthly',
        firstDueDate: '2026-04-01',
      },
      payments: [{ method: 'cash', amountCents: 150000 }],
    });

    // 2. Pay 75,000 cents: should fully pay installment 1 (50,000) and partially pay installment 2 (25,000 / 50,000)
    const payRes = await api('post', '/api/pos/credit/payments', shop.token).send({
      customerId: shop.customer._id,
      amountCents: 75000,
      paymentMethod: 'cash',
      reference: 'RCPT-COL-001',
    });

    expect(payRes.status).toBe(201);
    expect(payRes.body.data.amountPaidCents).toBe(75000);
    expect(payRes.body.data.unallocatedCents).toBe(0);
    expect(payRes.body.data.customerBalanceCents).toBe(75000); // 150,000 - 75,000

    // Check plan schedule statuses
    const updatedPlan = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await InstallmentPlan.findOne({ customerId: shop.customer._id });
    });
    expect(updatedPlan.schedule[0].status).toBe('paid');
    expect(updatedPlan.schedule[0].paidAmountCents).toBe(50000);

    expect(updatedPlan.schedule[1].status).toBe('partial');
    expect(updatedPlan.schedule[1].paidAmountCents).toBe(25000);

    expect(updatedPlan.schedule[2].status).toBe('pending');
    expect(updatedPlan.schedule[2].paidAmountCents).toBe(0);

    expect(updatedPlan.remainingBalanceCents).toBe(75000);

    // Check Ledger entry posted (Debit Cash 1010, Credit Accounts Receivable 1040)
    const ledgerEntry = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.findOne({ referenceType: 'installment' });
    });
    expect(ledgerEntry).toBeTruthy();
    const cashLine = ledgerEntry.lines.find((l) => l.accountCode === '1010');
    const arLine = ledgerEntry.lines.find((l) => l.accountCode === '1040');
    expect(cashLine.debit).toBe(75000);
    expect(arLine.credit).toBe(75000);
  });

  it('calculates aging buckets and tracks overdue installments', async () => {
    const shop = await setupCreditShop();

    // Create installment sale with 3 installments
    // Artificially age the installments:
    // Installment 1: 45 days ago -> '31-60' bucket
    // Installment 2: 15 days ago -> '1-30' bucket
    // Installment 3: in 15 days -> 'current' bucket
    const past45Days = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const past15Days = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const future15Days = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    let planId;
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const plan = await InstallmentPlan.create({
        branchId: shop.branchId,
        planNumber: 'IP-AGING-001',
        invoiceId: new mongoose.Types.ObjectId(),
        invoiceNumber: 'INV-AGING-001',
        customerId: shop.customer._id,
        customerSnapshot: { name: shop.customer.name, phone: shop.customer.phone },
        totalAmountCents: 150000,
        downPaymentCents: 0,
        financedAmountCents: 150000,
        remainingBalanceCents: 150000,
        numberOfInstallments: 3,
        frequency: 'monthly',
        schedule: [
          { installmentNumber: 1, dueDate: past45Days, amountCents: 50000, paidAmountCents: 0, status: 'pending' },
          { installmentNumber: 2, dueDate: past15Days, amountCents: 50000, paidAmountCents: 0, status: 'pending' },
          { installmentNumber: 3, dueDate: future15Days, amountCents: 50000, paidAmountCents: 0, status: 'pending' },
        ],
        status: 'active',
      });
      planId = plan._id;
    });

    // 1. Get aging breakdown
    const agingRes = await api('get', `/api/pos/credit/customers/${shop.customer._id}/aging`, shop.token);
    expect(agingRes.status).toBe(200);
    const { buckets, overdueInstallments } = agingRes.body.data;
    expect(buckets.current).toBe(50000);
    expect(buckets['1-30']).toBe(50000);
    expect(buckets['31-60']).toBe(50000);
    expect(buckets.totalOutstandingCents).toBe(150000);
    expect(overdueInstallments).toHaveLength(2); // Installments 1 & 2 are overdue

    // 2. Get branch overdue tracking endpoint
    const overdueRes = await api('get', '/api/pos/credit/overdue', shop.token);
    expect(overdueRes.status).toBe(200);
    expect(overdueRes.body.data.length).toBeGreaterThanOrEqual(2);

    // 3. Dispatch SMS reminder
    const remindRes = await api('post', `/api/pos/credit/remind/${planId}/1`, shop.token);
    expect(remindRes.status).toBe(200);
    expect(remindRes.body.success).toBe(true);
    expect(remindRes.body.data.sentTo).toBe(shop.customer.phone);
  });

  it('enforces tenant isolation: Tenant B cannot access Tenant A credit data or collect payments', async () => {
    const shopA = await setupCreditShop('shop-a-credit@shop.lk', 'Shop A Credit');
    const shopB = await setupCreditShop('shop-b-credit@shop.lk', 'Shop B Credit');

    // Tenant B attempts to view Customer A aging
    const agingB = await api('get', `/api/pos/credit/customers/${shopA.customer._id}/aging`, shopB.token);
    expect(agingB.status).toBe(404);

    // Tenant B attempts to collect payment for Customer A
    const payB = await api('post', '/api/pos/credit/payments', shopB.token).send({
      customerId: shopA.customer._id,
      amountCents: 10000,
    });
    expect(payB.status).toBe(404);
  });
});
