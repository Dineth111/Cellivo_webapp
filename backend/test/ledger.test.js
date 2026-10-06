import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext } from '../src/core/tenantContext.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import LedgerAccount from '../src/modules/pos/models/LedgerAccount.model.js';
import * as ledgerService from '../src/modules/pos/services/ledger.service.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function createShop(email = 'pos@shop.lk', name = 'POS Shop') {
  const shop = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', shop.token);
  const userData = meRes.body.data;
  const tenantId = userData.tenant._id;
  const branchId = userData.tenant.mainBranchId || userData.branchIds?.[0];
  return { ...shop, tenantId, branchId, userId: userData._id };
}

describe('POS Ledger Core & Double-Entry Accounting', () => {
  it('rejects unbalanced journal entries (debit !== credit or total <= 0)', async () => {
    const shop = await createShop();

    // 1. Unbalanced debits and credits
    await expect(
      ledgerService.postJournal({
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        referenceType: 'sale',
        referenceId: 'SALE-1',
        description: 'Unbalanced sale',
        lines: [
          { accountCode: '1010', debit: 10000, credit: 0 },
          { accountCode: '4010', debit: 0, credit: 9500 }, // off by 500
        ],
      })
    ).rejects.toThrow(/Unbalanced journal entry/);

    // 2. Zero amount entries
    await expect(
      ledgerService.postJournal({
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        referenceType: 'sale',
        referenceId: 'SALE-2',
        description: 'Zero amount sale',
        lines: [
          { accountCode: '1010', debit: 0, credit: 0 },
          { accountCode: '4010', debit: 0, credit: 0 },
        ],
      })
    ).rejects.toThrow(/Unbalanced journal entry/);

    // 3. Less than two lines
    await expect(
      ledgerService.postJournal({
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        referenceType: 'sale',
        referenceId: 'SALE-3',
        description: 'One line',
        lines: [{ accountCode: '1010', debit: 1000, credit: 0 }],
      })
    ).rejects.toThrow(/at least two lines/);
  });

  it('posts cash, card, and split payment sales with exact balances', async () => {
    const shop = await createShop();

    // Cash sale with tax and COGS
    const cashEntry = await ledgerService.postCashSale({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-CASH-1',
      amountCents: 50000, // 500.00
      taxCents: 5000,     // 50.00
      costCents: 30000,   // 300.00
      createdBy: shop.userId,
    });

    expect(cashEntry.entryNumber).toBeDefined();
    expect(cashEntry.lines).toHaveLength(5); // 1 cash + 1 sales + 1 tax + 1 COGS + 1 inventory
    const debitTotal = cashEntry.lines.reduce((s, l) => s + l.debit, 0);
    const creditTotal = cashEntry.lines.reduce((s, l) => s + l.credit, 0);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(80000); // 50000 cash + 30000 COGS

    // Card sale
    const cardEntry = await ledgerService.postCardSale({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-CARD-1',
      amountCents: 25000,
      taxCents: 2500,
      createdBy: shop.userId,
    });
    expect(cardEntry.lines).toHaveLength(3);
    expect(cardEntry.lines.find((l) => l.accountCode === '1020').debit).toBe(25000);

    // Split payment sale
    const splitEntry = await ledgerService.postSplitPayment({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-SPLIT-1',
      payments: [
        { method: 'cash', amountCents: 15000 },
        { method: 'card', amountCents: 10000 },
      ],
      totalCents: 25000,
      taxCents: 0,
      createdBy: shop.userId,
    });
    expect(splitEntry.lines).toHaveLength(3);
    expect(splitEntry.lines.find((l) => l.accountCode === '1010').debit).toBe(15000);
    expect(splitEntry.lines.find((l) => l.accountCode === '1020').debit).toBe(10000);
    expect(splitEntry.lines.find((l) => l.accountCode === '4010').credit).toBe(25000);
  });

  it('posts credit sales, installments, refunds, and trade-in entries correctly', async () => {
    const shop = await createShop();

    // 1. Credit sale: 100,000 total with 20,000 down payment
    const creditEntry = await ledgerService.postCreditSale({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-CREDIT-1',
      amountCents: 100000,
      paidAmountCents: 20000,
      paymentMethod: 'cash',
      taxCents: 0,
      createdBy: shop.userId,
    });
    expect(creditEntry.lines.find((l) => l.accountCode === '1040').debit).toBe(80000); // Receivable
    expect(creditEntry.lines.find((l) => l.accountCode === '1010').debit).toBe(20000); // Cash down
    expect(creditEntry.lines.find((l) => l.accountCode === '4010').credit).toBe(100000); // Sales

    // 2. Installment collection: customer pays 40,000 towards receivable
    const instEntry = await ledgerService.postInstallmentPayment({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      paymentId: 'INST-1',
      amountCents: 40000,
      paymentMethod: 'cash',
      createdBy: shop.userId,
    });
    expect(instEntry.lines.find((l) => l.accountCode === '1010').debit).toBe(40000);
    expect(instEntry.lines.find((l) => l.accountCode === '1040').credit).toBe(40000);

    // 3. Trade-in: Phone sold for 120,000; customer trades in old device valued at 50,000 and pays 70,000 cash
    const tradeInEntry = await ledgerService.postTradeIn({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-TRADE-1',
      tradeInValueCents: 50000,
      cashPaidCents: 70000,
      saleAmountCents: 120000,
      taxCents: 0,
      costCents: 80000,
      createdBy: shop.userId,
    });
    expect(tradeInEntry.lines.find((l) => l.accountCode === '1050' && l.debit === 50000)).toBeDefined(); // acquired device
    expect(tradeInEntry.lines.find((l) => l.accountCode === '1010').debit).toBe(70000); // cash balance

    // 4. Refund: customer returns 10,000 item, restocked cost 6,000
    const refundEntry = await ledgerService.postRefund({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      refundId: 'REF-1',
      amountCents: 10000,
      paymentMethod: 'cash',
      restockedCostCents: 6000,
      createdBy: shop.userId,
    });
    expect(refundEntry.lines.find((l) => l.accountCode === '4030').debit).toBe(10000); // Sales returns
    expect(refundEntry.lines.find((l) => l.accountCode === '1010').credit).toBe(10000); // Cash out
  });

  it('performs non-destructive void reversals and updates balances accurately', async () => {
    const shop = await createShop();

    // Post a sale
    const saleEntry = await ledgerService.postCashSale({
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      saleId: 'SALE-TO-VOID',
      amountCents: 30000,
      taxCents: 0,
      createdBy: shop.userId,
    });

    // Check balances before void
    let balances = await ledgerService.getAccountBalances(shop.tenantId);
    let cashBal = balances.find((b) => b.code === '1010');
    let salesBal = balances.find((b) => b.code === '4010');
    expect(cashBal.balance).toBe(30000);
    expect(salesBal.balance).toBe(30000);

    // Void the entry
    const { reversalEntry, originalEntry } = await ledgerService.postVoidReversal({
      tenantId: shop.tenantId,
      originalEntryNumber: saleEntry.entryNumber,
      reason: 'Customer cancelled transaction',
      createdBy: shop.userId,
    });

    expect(originalEntry.isVoided).toBe(true);
    expect(originalEntry.voidReason).toBe('Customer cancelled transaction');
    expect(reversalEntry.referenceType).toBe('void');
    expect(reversalEntry.lines.find((l) => l.accountCode === '1010').credit).toBe(30000);

    // Cannot void an already voided entry
    await expect(
      ledgerService.postVoidReversal({
        tenantId: shop.tenantId,
        originalEntryNumber: saleEntry.entryNumber,
      })
    ).rejects.toThrow(/already voided/);
  });

  it('enforces strict tenant isolation for ledger entries and accounts', async () => {
    const shopA = await createShop('a-ledger@shop.lk', 'Shop A');
    const shopB = await createShop('b-ledger@shop.lk', 'Shop B');

    // Post entries for Shop A
    await ledgerService.postCashSale({
      tenantId: shopA.tenantId,
      branchId: shopA.branchId,
      saleId: 'SHOP-A-SALE',
      amountCents: 75000,
      createdBy: shopA.userId,
    });

    // Post entries for Shop B
    await ledgerService.postCashSale({
      tenantId: shopB.tenantId,
      branchId: shopB.branchId,
      saleId: 'SHOP-B-SALE',
      amountCents: 15000,
      createdBy: shopB.userId,
    });

    // Model queries within Shop A context should only see Shop A's entries
    await runWithContext({ tenantId: shopA.tenantId }, async () => {
      const entries = await LedgerEntry.find({});
      expect(entries).toHaveLength(1);
      expect(entries[0].referenceId).toBe('SHOP-A-SALE');
      expect(String(entries[0].tenantId)).toBe(shopA.tenantId);
    });

    // Balances calculation for Shop B should only reflect Shop B's 15,000 cents
    const balancesB = await ledgerService.getAccountBalances(shopB.tenantId);
    const cashB = balancesB.find((b) => b.code === '1010');
    expect(cashB.balance).toBe(15000);

    const balancesA = await ledgerService.getAccountBalances(shopA.tenantId);
    const cashA = balancesA.find((b) => b.code === '1010');
    expect(cashA.balance).toBe(75000);
  });

  it('provides working HTTP endpoints for external posting and balances', async () => {
    const shop = await createShop('http-ledger@shop.lk', 'HTTP Shop');

    // POST /api/pos/ledger/journal (as used by Dev 4 Purchasing & Dev 5 Repairs)
    const postRes = await api('post', '/api/pos/ledger/journal', shop.token).send({
      referenceType: 'manual',
      referenceId: 'DEV4-PURCHASE-1',
      description: 'Inventory purchase from supplier',
      lines: [
        { accountCode: '1050', debit: 50000, credit: 0, description: 'Stock received' },
        { accountCode: '1030', debit: 0, credit: 50000, description: 'Bank transfer paid' },
      ],
    });

    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.data.entryNumber).toBeDefined();

    // GET /api/pos/ledger/balances
    const getRes = await api('get', '/api/pos/ledger/balances', shop.token);
    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);
    expect(Array.isArray(getRes.body.data)).toBe(true);

    const inventoryAcc = getRes.body.data.find((a) => a.code === '1050');
    expect(inventoryAcc.balance).toBe(50000);
  });
});
