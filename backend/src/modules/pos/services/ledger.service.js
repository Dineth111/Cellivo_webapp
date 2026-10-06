import mongoose from 'mongoose';
import LedgerAccount from '../models/LedgerAccount.model.js';
import LedgerEntry from '../models/LedgerEntry.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { round, add, subtract } from '../money.js';

export const DEFAULT_ACCOUNTS = [
  { code: '1010', name: 'Cash', type: 'asset' },
  { code: '1020', name: 'Card clearing', type: 'asset' },
  { code: '1030', name: 'Bank', type: 'asset' },
  { code: '1040', name: 'Accounts receivable', type: 'asset' },
  { code: '1050', name: 'Inventory', type: 'asset' },
  { code: '2010', name: 'Tax payable', type: 'liability' },
  { code: '2020', name: 'Store credit', type: 'liability' },
  { code: '2030', name: 'Loyalty liability', type: 'liability' },
  { code: '4010', name: 'Sales', type: 'revenue' },
  { code: '4020', name: 'Other income', type: 'revenue' },
  { code: '4030', name: 'Sales returns', type: 'revenue' },
  { code: '5010', name: 'COGS', type: 'expense' },
  { code: '5020', name: 'Expenses', type: 'expense' },
];

const ACCOUNT_NAME_MAP = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, a.name]));

/**
 * Ensures that the tenant has the default Chart of Accounts seeded.
 */
export async function ensureDefaultAccounts(tenantId, session = null) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, async () => {
    const existing = await LedgerAccount.find({}).session(session).select('code').lean();
    const existingCodes = new Set(existing.map((a) => a.code));

    const toCreate = DEFAULT_ACCOUNTS
      .filter((a) => !existingCodes.has(a.code))
      .map((a) => ({ code: a.code, name: a.name, type: a.type, tenantId: tid }));

    if (toCreate.length > 0) {
      await LedgerAccount.insertMany(toCreate, { session });
    }
    return await LedgerAccount.find({}).session(session).lean();
  });
}

/**
 * Generates a unique entry number for the tenant.
 */
function generateEntryNumber(prefix = 'JRN') {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${ts}-${rnd}`;
}

/**
 * Validates and posts a double-entry journal.
 * STRICT ENFORCEMENT: Rejects unbalanced entries (total debits !== total credits) or debit <= 0 with status 400.
 */
export async function postJournal({
  tenantId,
  branchId = null,
  referenceType,
  referenceId = '',
  description = '',
  lines = [],
  createdBy = null,
  session = null,
}) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw badRequest('Journal entry must have at least two lines', 'INVALID_JOURNAL_LINES');
  }

  // Ensure default accounts exist for line validation and name enrichment
  await ensureDefaultAccounts(tenantId, session);

  let totalDebits = 0;
  let totalCredits = 0;

  const normalizedLines = lines.map((l) => {
    const debit = round(l.debit || 0);
    const credit = round(l.credit || 0);

    if (debit < 0 || credit < 0) {
      throw badRequest('Debit and credit amounts cannot be negative', 'NEGATIVE_AMOUNT');
    }
    if (debit > 0 && credit > 0) {
      throw badRequest('A single line cannot have both a debit and a credit', 'INVALID_LINE');
    }

    totalDebits = add(totalDebits, debit);
    totalCredits = add(totalCredits, credit);

    const accountCode = String(l.accountCode || '').trim();
    if (!accountCode) {
      throw badRequest('Account code is required for every line', 'MISSING_ACCOUNT_CODE');
    }

    const accountName = l.accountName || ACCOUNT_NAME_MAP[accountCode] || `Account ${accountCode}`;

    return {
      accountCode,
      accountName,
      debit,
      credit,
      description: l.description || description || '',
    };
  });

  if (totalDebits !== totalCredits || totalDebits <= 0) {
    throw badRequest(
      `Unbalanced journal entry: total debits (${totalDebits}) must equal total credits (${totalCredits}) and be greater than 0`,
      'UNBALANCED_JOURNAL'
    );
  }

  return await runWithContext({ tenantId }, async () => {
    const entry = new LedgerEntry({
      branchId,
      entryNumber: generateEntryNumber(referenceType === 'void' ? 'REV' : 'JRN'),
      date: new Date(),
      referenceType,
      referenceId: String(referenceId || ''),
      description,
      lines: normalizedLines,
      createdBy,
    });

    await entry.save({ session });
    return entry;
  });
}

/**
 * Posts a cash sale to the ledger.
 */
export async function postCashSale({
  tenantId,
  branchId,
  saleId,
  amountCents,
  taxCents = 0,
  costCents = 0,
  createdBy = null,
  session = null,
}) {
  const salesRev = subtract(amountCents, taxCents);
  const lines = [
    { accountCode: '1010', debit: round(amountCents), credit: 0, description: `Cash received for sale ${saleId}` },
    { accountCode: '4010', debit: 0, credit: salesRev, description: `Sales revenue for sale ${saleId}` },
  ];

  if (taxCents > 0) {
    lines.push({ accountCode: '2010', debit: 0, credit: round(taxCents), description: `Tax payable for sale ${saleId}` });
  }

  if (costCents > 0) {
    lines.push(
      { accountCode: '5010', debit: round(costCents), credit: 0, description: `COGS for sale ${saleId}` },
      { accountCode: '1050', debit: 0, credit: round(costCents), description: `Inventory reduction for sale ${saleId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'sale',
    referenceId: saleId,
    description: `Cash sale ${saleId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a card sale to the ledger.
 */
export async function postCardSale({
  tenantId,
  branchId,
  saleId,
  amountCents,
  taxCents = 0,
  costCents = 0,
  createdBy = null,
  session = null,
}) {
  const salesRev = subtract(amountCents, taxCents);
  const lines = [
    { accountCode: '1020', debit: round(amountCents), credit: 0, description: `Card clearing for sale ${saleId}` },
    { accountCode: '4010', debit: 0, credit: salesRev, description: `Sales revenue for sale ${saleId}` },
  ];

  if (taxCents > 0) {
    lines.push({ accountCode: '2010', debit: 0, credit: round(taxCents), description: `Tax payable for sale ${saleId}` });
  }

  if (costCents > 0) {
    lines.push(
      { accountCode: '5010', debit: round(costCents), credit: 0, description: `COGS for sale ${saleId}` },
      { accountCode: '1050', debit: 0, credit: round(costCents), description: `Inventory reduction for sale ${saleId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'sale',
    referenceId: saleId,
    description: `Card sale ${saleId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a split-payment sale to the ledger.
 * @param payments Array of { method: 'cash'|'card'|'bank'|'store_credit'|'credit', amountCents: number }
 */
export async function postSplitPayment({
  tenantId,
  branchId,
  saleId,
  payments = [],
  totalCents,
  taxCents = 0,
  costCents = 0,
  createdBy = null,
  session = null,
}) {
  const methodAccounts = {
    cash: '1010',
    card: '1020',
    bank: '1030',
    credit: '1040',
    store_credit: '2020',
    loyalty_points: '2030',
  };

  const lines = [];
  let sumPaid = 0;

  for (const p of payments) {
    const amt = round(p.amountCents);
    if (amt <= 0) continue;
    sumPaid = add(sumPaid, amt);
    const code = methodAccounts[p.method] || '1010';
    lines.push({
      accountCode: code,
      debit: amt,
      credit: 0,
      description: `Payment via ${p.method} for sale ${saleId}`,
    });
  }

  if (sumPaid !== round(totalCents)) {
    throw badRequest(`Payment total (${sumPaid}) does not match sale total (${totalCents})`, 'PAYMENT_MISMATCH');
  }

  const salesRev = subtract(totalCents, taxCents);
  lines.push({
    accountCode: '4010',
    debit: 0,
    credit: salesRev,
    description: `Sales revenue for sale ${saleId}`,
  });

  if (taxCents > 0) {
    lines.push({
      accountCode: '2010',
      debit: 0,
      credit: round(taxCents),
      description: `Tax payable for sale ${saleId}`,
    });
  }

  if (costCents > 0) {
    lines.push(
      { accountCode: '5010', debit: round(costCents), credit: 0, description: `COGS for sale ${saleId}` },
      { accountCode: '1050', debit: 0, credit: round(costCents), description: `Inventory reduction for sale ${saleId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'sale',
    referenceId: saleId,
    description: `Split payment sale ${saleId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a credit sale (invoice to customer on credit).
 */
export async function postCreditSale({
  tenantId,
  branchId,
  saleId,
  amountCents,
  paidAmountCents = 0,
  paymentMethod = 'cash',
  taxCents = 0,
  costCents = 0,
  createdBy = null,
  session = null,
}) {
  const receivableCents = subtract(amountCents, paidAmountCents);
  const salesRev = subtract(amountCents, taxCents);
  const lines = [];

  if (receivableCents > 0) {
    lines.push({
      accountCode: '1040',
      debit: receivableCents,
      credit: 0,
      description: `Accounts receivable for credit sale ${saleId}`,
    });
  }

  if (paidAmountCents > 0) {
    const acc = paymentMethod === 'card' ? '1020' : '1010';
    lines.push({
      accountCode: acc,
      debit: round(paidAmountCents),
      credit: 0,
      description: `Down payment via ${paymentMethod} for credit sale ${saleId}`,
    });
  }

  lines.push({
    accountCode: '4010',
    debit: 0,
    credit: salesRev,
    description: `Sales revenue for credit sale ${saleId}`,
  });

  if (taxCents > 0) {
    lines.push({
      accountCode: '2010',
      debit: 0,
      credit: round(taxCents),
      description: `Tax payable for credit sale ${saleId}`,
    });
  }

  if (costCents > 0) {
    lines.push(
      { accountCode: '5010', debit: round(costCents), credit: 0, description: `COGS for credit sale ${saleId}` },
      { accountCode: '1050', debit: 0, credit: round(costCents), description: `Inventory reduction for credit sale ${saleId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'credit_sale',
    referenceId: saleId,
    description: `Credit sale ${saleId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts an installment/credit settlement payment from a customer.
 */
export async function postInstallmentPayment({
  tenantId,
  branchId,
  paymentId,
  amountCents,
  paymentMethod = 'cash',
  createdBy = null,
  session = null,
}) {
  const methodAcc = paymentMethod === 'card' ? '1020' : paymentMethod === 'bank' ? '1030' : '1010';
  const lines = [
    { accountCode: methodAcc, debit: round(amountCents), credit: 0, description: `Installment collection via ${paymentMethod}` },
    { accountCode: '1040', debit: 0, credit: round(amountCents), description: `Receivable cleared for installment payment ${paymentId}` },
  ];

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'installment',
    referenceId: paymentId,
    description: `Installment payment ${paymentId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a sales refund.
 */
export async function postRefund({
  tenantId,
  branchId,
  refundId,
  amountCents,
  paymentMethod = 'cash',
  restockedCostCents = 0,
  createdBy = null,
  session = null,
}) {
  const payoutAcc = paymentMethod === 'card' ? '1020' : paymentMethod === 'store_credit' ? '2020' : '1010';
  const lines = [
    { accountCode: '4030', debit: round(amountCents), credit: 0, description: `Sales returns for refund ${refundId}` },
    { accountCode: payoutAcc, debit: 0, credit: round(amountCents), description: `Refund payout via ${paymentMethod}` },
  ];

  if (restockedCostCents > 0) {
    lines.push(
      { accountCode: '1050', debit: round(restockedCostCents), credit: 0, description: `Inventory returned for refund ${refundId}` },
      { accountCode: '5010', debit: 0, credit: round(restockedCostCents), description: `COGS reversal for refund ${refundId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'refund',
    referenceId: refundId,
    description: `Sales refund ${refundId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a store credit allocation.
 */
export async function postStoreCredit({
  tenantId,
  branchId,
  customerId,
  amountCents,
  reason = 'Store credit issued',
  createdBy = null,
  session = null,
}) {
  const lines = [
    { accountCode: '4030', debit: round(amountCents), credit: 0, description: `Store credit issued: ${reason}` },
    { accountCode: '2020', debit: 0, credit: round(amountCents), description: `Store credit liability for customer ${customerId}` },
  ];

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'payment',
    referenceId: customerId,
    description: `Store credit: ${reason}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts a sale with trade-in deduction.
 */
export async function postTradeIn({
  tenantId,
  branchId,
  saleId,
  tradeInValueCents,
  saleAmountCents,
  cashPaidCents,
  taxCents = 0,
  costCents = 0,
  createdBy = null,
  session = null,
}) {
  const tradeInVal = round(tradeInValueCents);
  const cashPaid = round(cashPaidCents);
  const totalReceived = add(tradeInVal, cashPaid);

  if (totalReceived !== round(saleAmountCents)) {
    throw badRequest(
      `Trade-in value (${tradeInVal}) + Cash paid (${cashPaid}) must equal sale amount (${saleAmountCents})`,
      'TRADE_IN_MISMATCH'
    );
  }

  const salesRev = subtract(saleAmountCents, taxCents);
  const lines = [
    { accountCode: '1050', debit: tradeInVal, credit: 0, description: `Trade-in device acquired for sale ${saleId}` },
    { accountCode: '1010', debit: cashPaid, credit: 0, description: `Cash received for balance of sale ${saleId}` },
    { accountCode: '4010', debit: 0, credit: salesRev, description: `Sales revenue for trade-in sale ${saleId}` },
  ];

  if (taxCents > 0) {
    lines.push({
      accountCode: '2010',
      debit: 0,
      credit: round(taxCents),
      description: `Tax payable for sale ${saleId}`,
    });
  }

  if (costCents > 0) {
    lines.push(
      { accountCode: '5010', debit: round(costCents), credit: 0, description: `COGS for sale ${saleId}` },
      { accountCode: '1050', debit: 0, credit: round(costCents), description: `Sold inventory deduction for sale ${saleId}` }
    );
  }

  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'trade_in',
    referenceId: saleId,
    description: `Trade-in sale ${saleId}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Non-destructive void reversal of a posted journal entry.
 * Inverts all debits and credits, posts a reversal entry, and marks the original entry as voided.
 */
export async function postVoidReversal({
  tenantId,
  originalEntryNumber,
  reason = 'Void reversal',
  createdBy = null,
  session = null,
}) {
  return await runWithContext({ tenantId }, async () => {
    const original = await LedgerEntry.findOne({ entryNumber: originalEntryNumber }).session(session);
    if (!original) {
      throw notFound(`Ledger entry ${originalEntryNumber} not found`);
    }
    if (original.isVoided) {
      throw badRequest(`Ledger entry ${originalEntryNumber} is already voided`, 'ALREADY_VOIDED');
    }

    const reversalLines = original.lines.map((l) => ({
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal of ${original.entryNumber}: ${reason}`,
    }));

    const reversalEntry = await postJournal({
      tenantId,
      branchId: original.branchId,
      referenceType: 'void',
      referenceId: original.entryNumber,
      description: `Void reversal of ${original.entryNumber}: ${reason}`,
      lines: reversalLines,
      createdBy,
      session,
    });

    original.isVoided = true;
    original.voidReason = reason;
    original.voidedAt = new Date();
    await original.save({ session });

    return { reversalEntry, originalEntry: original };
  });
}

/**
 * Computes current account balances for the tenant.
 * Aggregates all non-voided ledger lines and computes normal balance based on account type:
 * - Asset & Expense: normal balance = debits - credits
 * - Liability, Equity, Revenue: normal balance = credits - debits
 */
export async function getAccountBalances(tenantId, branchId = null) {
  return await runWithContext({ tenantId }, async () => {
    await ensureDefaultAccounts(tenantId);
    const accounts = await LedgerAccount.find({}).lean();

    const match = { isVoided: { $ne: true } };
    if (branchId) {
      match.branchId = new mongoose.Types.ObjectId(String(branchId));
    }

    const agg = await LedgerEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.accountCode',
          totalDebit: { $sum: '$lines.debit' },
          totalCredit: { $sum: '$lines.credit' },
        },
      },
    ]);

    const aggMap = new Map(agg.map((a) => [a._id, a]));

    return accounts.map((acc) => {
      const totals = aggMap.get(acc.code) || { totalDebit: 0, totalCredit: 0 };
      const totalDebit = totals.totalDebit || 0;
      const totalCredit = totals.totalCredit || 0;

      let balance = 0;
      if (['asset', 'expense'].includes(acc.type)) {
        balance = subtract(totalDebit, totalCredit);
      } else {
        balance = subtract(totalCredit, totalDebit);
      }

      return {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        totalDebit,
        totalCredit,
        balance,
      };
    });
  });
}

/**
 * Posts Bank Deposit from Drawer Cash.
 * Debit: Bank (1030)
 * Credit: Cash (1010)
 */
export async function postBankDeposit({
  tenantId,
  branchId,
  amountCents,
  depositId,
  createdBy = null,
  session = null,
}) {
  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'payment',
    referenceId: `DEP-${depositId || Date.now()}`,
    description: `Cash deposit to bank account`,
    lines: [
      { accountCode: '1030', debit: amountCents, credit: 0 },
      { accountCode: '1010', debit: 0, credit: amountCents },
    ],
    createdBy,
    session,
  });
}

/**
 * Posts Cheque Bounce Reversal.
 * Customer liability re-established.
 * Debit: Accounts Receivable (1040)
 * Credit: Bank (1030)
 */
export async function postChequeBounce({
  tenantId,
  branchId,
  amountCents,
  chequeNumber,
  reason = 'Cheque bounced',
  createdBy = null,
  session = null,
}) {
  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'void',
    referenceId: `CHK-BNC-${chequeNumber}`,
    description: `Cheque #${chequeNumber} bounce reversal: ${reason}`,
    lines: [
      { accountCode: '1040', debit: amountCents, credit: 0 },
      { accountCode: '1030', debit: 0, credit: amountCents },
    ],
    createdBy,
    session,
  });
}

/**
 * Posts Expense entry.
 * Debit: Expenses (5020)
 * Credit: Cash (1010) or Bank (1030)
 */
export async function postExpense({
  tenantId,
  branchId,
  amountCents,
  paymentMethod = 'cash',
  category,
  payee,
  expenseId,
  createdBy = null,
  session = null,
}) {
  const creditCode = paymentMethod === 'bank' ? '1030' : '1010';
  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'payment',
    referenceId: `EXP-${expenseId || Date.now()}`,
    description: `Expense: ${category} to ${payee}`,
    lines: [
      { accountCode: '5020', debit: amountCents, credit: 0 },
      { accountCode: creditCode, debit: 0, credit: amountCents },
    ],
    createdBy,
    session,
  });
}

/**
 * Posts Other Income entry.
 * Debit: Cash (1010) or Bank (1030)
 * Credit: Other income (4020)
 */
export async function postOtherIncome({
  tenantId,
  branchId,
  amountCents,
  paymentMethod = 'cash',
  description = 'Other Income',
  reference = null,
  createdBy = null,
  session = null,
}) {
  const debitCode = paymentMethod === 'bank' ? '1030' : '1010';
  return await postJournal({
    tenantId,
    branchId,
    referenceType: 'payment',
    referenceId: reference || `INC-${Date.now()}`,
    description,
    lines: [
      { accountCode: debitCode, debit: amountCents, credit: 0 },
      { accountCode: '4020', debit: 0, credit: amountCents },
    ],
    createdBy,
    session,
  });
}

export default {
  DEFAULT_ACCOUNTS,
  ensureDefaultAccounts,
  postJournal,
  postCashSale,
  postCardSale,
  postSplitPayment,
  postCreditSale,
  postInstallmentPayment,
  postRefund,
  postStoreCredit,
  postTradeIn,
  postVoidReversal,
  postBankDeposit,
  postChequeBounce,
  postExpense,
  postOtherIncome,
  getAccountBalances,
};
