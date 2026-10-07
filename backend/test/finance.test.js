import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import User from '../src/modules/users/User.model.js';
import Role from '../src/modules/roles/Role.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import Customer from '../src/modules/customers/Customer.model.js';
import CashSession from '../src/modules/pos/models/CashSession.model.js';
import BankAccount from '../src/modules/pos/models/BankAccount.model.js';
import Cheque from '../src/modules/pos/models/Cheque.model.js';
import Expense from '../src/modules/pos/models/Expense.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(plan = 'pro', email = 'cashier@cellivo.lk') {
  const s = await signup(email, 'Cellivo Retail');
  const meRes = await api('get', '/api/auth/me', s.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0] || null;
  const userId = userData._id;

  await runAsPlatform(async () => {
    await Tenant.findByIdAndUpdate(tenantId, { plan, subscriptionStatus: 'active' });
    const pinHash = await bcrypt.hash('1234', 10);
    const mgrRole = await Role.findOne({ tenantId, key: 'owner' });
    await User.findByIdAndUpdate(userId, { approvalPinHash: pinHash, roleId: mgrRole._id });
  });

  return { token: s.token, tenantId, branchId, userId };
}

describe('PHASE 7: Cash Drawer and Finance (FIN-01 to FIN-07)', () => {
  it('1. Cash Drawer lifecycle: open session, block duplicate open, cash movements update expected cash', async () => {
    const { token, tenantId } = await setupShop();

    // Open session
    const openRes = await api('post', '/api/pos/finance/drawer/open', token).send({
      openingFloatCents: 10000, // 100 LKR
      terminalId: 'POS-1',
    });
    expect(openRes.status).toBe(201);
    expect(openRes.body.data.status).toBe('open');
    expect(openRes.body.data.openingFloatCents).toBe(10000);
    expect(openRes.body.data.expectedCashCents).toBe(10000);

    const sessionId = openRes.body.data._id;

    // Reject duplicate open session
    const dupRes = await api('post', '/api/pos/finance/drawer/open', token).send({
      openingFloatCents: 5000,
    });
    expect(dupRes.status).toBe(409);

    // Get current session
    const curRes = await api('get', '/api/pos/finance/drawer/current', token);
    expect(curRes.status).toBe(200);
    expect(curRes.body.data._id).toBe(sessionId);

    // Record cash in (pay-in)
    const cinRes = await api('post', '/api/pos/finance/drawer/movement', token).send({
      sessionId,
      type: 'cash_in',
      amountCents: 2000,
      reason: 'Petty cash top-up',
    });
    expect(cinRes.status).toBe(200);
    expect(cinRes.body.data.expectedCashCents).toBe(12000);

    // Record cash out (pay-out)
    const coutRes = await api('post', '/api/pos/finance/drawer/movement', token).send({
      sessionId,
      type: 'cash_out',
      amountCents: 1500,
      reason: 'Office coffee supplies',
    });
    expect(coutRes.status).toBe(200);
    expect(coutRes.body.data.expectedCashCents).toBe(10500);
  });

  it('2. Cash checkout & returns automatically update active drawer session cashSales and cashRefunds', async () => {
    const { token, tenantId, branchId } = await setupShop();

    // Seed stock
    await runWithContext({ tenantId }, async () => {
      await FakeStock.create({
        tenantId,
        branchId,
        barcode: 'FIN-PHONE-01',
        name: 'Finance Test Phone',
        sellingPriceCents: 50000,
        costPriceCents: 30000,
        qty: 10,
      });
    });

    // Open session
    const openRes = await api('post', '/api/pos/finance/drawer/open', token).send({
      openingFloatCents: 10000,
    });
    const sessionId = openRes.body.data._id;

    // Checkout cash sale
    const saleRes = await api('post', '/api/pos/sales/checkout', token).send({
      lines: [{
        barcode: 'FIN-PHONE-01',
        name: 'Finance Test Phone',
        unitPriceCents: 50000,
        qty: 1,
      }],
      payments: [{ method: 'cash', amountCents: 50000 }],
    });
    expect(saleRes.status).toBe(201);
    const inv = saleRes.body.data;

    // Verify session updated
    const curSession = await api('get', '/api/pos/finance/drawer/current', token);
    expect(curSession.body.data.cashSalesCents).toBe(50000);
    expect(curSession.body.data.expectedCashCents).toBe(60000); // 10000 float + 50000 sale

    // Process return with cash refund
    const retRes = await api('post', '/api/pos/returns', token).send({
      invoiceId: inv._id,
      items: [{
        lineId: inv.lines[0]._id,
        barcode: 'FIN-PHONE-01',
        qty: 1,
        condition: 'Resellable',
        refundCents: 50000,
      }],
      refundMethod: 'cash',
    });
    expect(retRes.status).toBe(201);

    // Verify session cash refunds updated
    const afterRefund = await api('get', '/api/pos/finance/drawer/current', token);
    expect(afterRefund.body.data.cashRefundsCents).toBe(50000);
    expect(afterRefund.body.data.expectedCashCents).toBe(10000); // Back to float
  });

  it('3. Denomination count, variance check, manager PIN requirement, and Z-report generation', async () => {
    const { token } = await setupShop();

    // Open session with float 10,000 cents
    const openRes = await api('post', '/api/pos/finance/drawer/open', token).send({
      openingFloatCents: 10000,
    });
    const sessionId = openRes.body.data._id;

    // Attempt close with counted 70,000 (variance +60,000 cents > tolerance 50,000 cents) without PIN
    const failClose = await api('post', '/api/pos/finance/drawer/close', token).send({
      sessionId,
      countedCashCents: 70000,
      denominations: { 5000: 14 },
    });
    expect(failClose.status).toBe(403);
    expect(failClose.body.code).toBe('VARIANCE_REQUIRES_APPROVAL');

    // Close with wrong PIN
    const wrongPinClose = await api('post', '/api/pos/finance/drawer/close', token).send({
      sessionId,
      countedCashCents: 70000,
      denominations: { 5000: 14 },
      managerPin: '9999',
    });
    expect(wrongPinClose.status).toBe(403);
    expect(wrongPinClose.body.code).toBe('INVALID_MANAGER_PIN');

    // Close with valid manager PIN '1234'
    const successClose = await api('post', '/api/pos/finance/drawer/close', token).send({
      sessionId,
      countedCashCents: 70000,
      denominations: { 5000: 14 },
      managerPin: '1234',
    });
    expect(successClose.status).toBe(200);
    expect(successClose.body.data.status).toBe('approved');
    expect(successClose.body.data.varianceCents).toBe(60000);
    expect(successClose.body.data.requiresApproval).toBe(true);
    expect(successClose.body.data.zReport).toBeTruthy();
    expect(successClose.body.data.zReport.countedCashCents).toBe(70000);

    // Fetch Z-Report endpoint
    const zRes = await api('get', `/api/pos/finance/drawer/z-report/${sessionId}`, token);
    expect(zRes.status).toBe(200);
    expect(zRes.body.data.varianceCents).toBe(60000);
    expect(zRes.body.data.reportId).toMatch(/^Z-/);
  });

  it('4. Bank Deposit: transfers cash from drawer to bank and posts double-entry journal', async () => {
    const { token, tenantId } = await setupShop();

    // Create Bank Account
    const baRes = await api('post', '/api/pos/finance/banking/accounts', token).send({
      accountName: 'Main Commercial Account',
      bankName: 'Commercial Bank of Ceylon',
      accountNumber: '8001234567',
      balanceCents: 100000,
    });
    expect(baRes.status).toBe(201);
    const bankAccountId = baRes.body.data._id;

    // Open session with float 50,000
    const openRes = await api('post', '/api/pos/finance/drawer/open', token).send({
      openingFloatCents: 50000,
    });
    const sessionId = openRes.body.data._id;

    // Deposit 30,000 from drawer to bank
    const depRes = await api('post', '/api/pos/finance/banking/deposit', token).send({
      sessionId,
      bankAccountId,
      amountCents: 30000,
    });
    expect(depRes.status).toBe(200);
    expect(depRes.body.data.bankAccount.balanceCents).toBe(130000);
    expect(depRes.body.data.cashSession.expectedCashCents).toBe(20000);

    // Verify double-entry ledger entry: Debit Bank (1030) 30000, Credit Cash (1010) 30000
    await runWithContext({ tenantId }, async () => {
      const entry = await LedgerEntry.findOne({ tenantId, description: 'Cash deposit to bank account' });
      expect(entry).toBeTruthy();
      const debitSum = entry.lines.reduce((s, l) => s + l.debit, 0);
      const creditSum = entry.lines.reduce((s, l) => s + l.credit, 0);
      expect(debitSum).toBe(creditSum);
      const bankLine = entry.lines.find((l) => l.accountCode === '1030');
      const cashLine = entry.lines.find((l) => l.accountCode === '1010');
      expect(bankLine.debit).toBe(30000);
      expect(cashLine.credit).toBe(30000);
    });
  });

  it('5. Cheque lifecycle: record, clear, and bounce with customer balance reopening & reversal journal', async () => {
    const { token, tenantId } = await setupShop();

    // Create customer
    const custRes = await api('post', '/api/customers', token).send({
      name: 'Cheque Customer',
      phone: '0779998877',
    });
    const customerId = custRes.body.data._id;

    // Record cheque
    const chkRes = await api('post', '/api/pos/finance/cheques', token).send({
      chequeNumber: 'CHK-9001',
      bankName: 'Hatton National Bank',
      amountCents: 45000,
      partyName: 'Cheque Customer',
      customerId,
      maturityDate: new Date().toISOString(),
    });
    expect(chkRes.status).toBe(201);
    expect(chkRes.body.data.status).toBe('pending');
    const chequeId = chkRes.body.data._id;

    // Mark as deposited
    const depRes = await api('patch', `/api/pos/finance/cheques/${chequeId}/status`, token).send({
      status: 'deposited',
    });
    expect(depRes.status).toBe(200);
    expect(depRes.body.data.status).toBe('deposited');

    // Bounce cheque
    const bounceRes = await api('patch', `/api/pos/finance/cheques/${chequeId}/status`, token).send({
      status: 'bounced',
      reason: 'Insufficient funds (Refer to drawer)',
    });
    expect(bounceRes.status).toBe(200);
    expect(bounceRes.body.data.status).toBe('bounced');
    expect(bounceRes.body.data.bouncedReason).toBe('Insufficient funds (Refer to drawer)');

    // Verify Customer balance reopened by 45,000 cents
    const updatedCust = (await api('get', `/api/customers/${customerId}`, token)).body.data;
    expect(updatedCust.currentBalanceCents).toBe(45000);

    // Verify double-entry reversal journal: Debit AR (1040) 45000, Credit Bank (1030) 45000
    await runWithContext({ tenantId }, async () => {
      const entry = await LedgerEntry.findOne({ tenantId, referenceId: 'CHK-BNC-CHK-9001' });
      expect(entry).toBeTruthy();
      const debitSum = entry.lines.reduce((s, l) => s + l.debit, 0);
      const creditSum = entry.lines.reduce((s, l) => s + l.credit, 0);
      expect(debitSum).toBe(creditSum);
      const arLine = entry.lines.find((l) => l.accountCode === '1040');
      const bankLine = entry.lines.find((l) => l.accountCode === '1030');
      expect(arLine.debit).toBe(45000);
      expect(bankLine.credit).toBe(45000);
    });
  });

  it('6. Expenses & Day-End reconciliation report', async () => {
    const { token, tenantId } = await setupShop();

    // Record an expense
    const expRes = await api('post', '/api/pos/finance/expenses', token).send({
      category: 'Utilities',
      amountCents: 12000,
      paymentMethod: 'cash',
      payee: 'CEB Electricity Board',
      notes: 'Monthly store power bill',
    });
    expect(expRes.status).toBe(201);
    expect(expRes.body.data.category).toBe('Utilities');

    // Verify ledger entry: Debit Expenses (5020), Credit Cash (1010)
    await runWithContext({ tenantId }, async () => {
      const entry = await LedgerEntry.findOne({ tenantId, description: 'Expense: Utilities to CEB Electricity Board' });
      expect(entry).toBeTruthy();
      const debitSum = entry.lines.reduce((s, l) => s + l.debit, 0);
      const creditSum = entry.lines.reduce((s, l) => s + l.credit, 0);
      expect(debitSum).toBe(creditSum);
      const expLine = entry.lines.find((l) => l.accountCode === '5020');
      const cashLine = entry.lines.find((l) => l.accountCode === '1010');
      expect(expLine.debit).toBe(12000);
      expect(cashLine.credit).toBe(12000);
    });

    // Request Day-End Report
    const dayEndRes = await api('get', '/api/pos/finance/day-end', token);
    expect(dayEndRes.status).toBe(200);
    expect(dayEndRes.body.data.totals).toBeDefined();
    expect(typeof dayEndRes.body.data.sessionsCount).toBe('number');
  });

  it('7. Tenant isolation: Tenant B cannot access or close Tenant A drawer session or cheques', async () => {
    const a = await setupShop('pro', 'shopa@cellivo.lk');
    const b = await setupShop('pro', 'shopb@cellivo.lk');

    // Tenant A opens drawer
    const openRes = await api('post', '/api/pos/finance/drawer/open', a.token).send({
      openingFloatCents: 15000,
    });
    const aSessionId = openRes.body.data._id;

    // Tenant A records a cheque
    const chkRes = await api('post', '/api/pos/finance/cheques', a.token).send({
      chequeNumber: 'A-CHK-100',
      bankName: 'Seylan Bank',
      amountCents: 20000,
      partyName: 'A Customer',
      maturityDate: new Date().toISOString(),
    });
    const aChequeId = chkRes.body.data._id;

    // Tenant B cannot see Tenant A's open session in current
    const bCurRes = await api('get', '/api/pos/finance/drawer/current', b.token);
    expect(bCurRes.body.data).toBeNull();

    // Tenant B cannot close Tenant A's session
    const bCloseRes = await api('post', '/api/pos/finance/drawer/close', b.token).send({
      sessionId: aSessionId,
      countedCashCents: 15000,
    });
    expect(bCloseRes.status).toBe(404);

    // Tenant B cannot update Tenant A's cheque
    const bChkRes = await api('patch', `/api/pos/finance/cheques/${aChequeId}/status`, b.token).send({
      status: 'cleared',
    });
    expect(bChkRes.status).toBe(404);
  });
});
