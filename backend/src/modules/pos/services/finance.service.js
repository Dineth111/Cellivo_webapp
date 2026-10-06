import mongoose from 'mongoose';
import CashSession from '../models/CashSession.model.js';
import BankAccount from '../models/BankAccount.model.js';
import Cheque from '../models/Cheque.model.js';
import Expense from '../models/Expense.model.js';
import Customer from '../../customers/Customer.model.js';
import Invoice from '../models/Invoice.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound, forbidden, conflict } from '../../../core/errors.js';
import { verifyApprovalPin } from '../adapters/approvalPin.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import * as ledgerService from './ledger.service.js';

export const DEFAULT_VARIANCE_TOLERANCE_CENTS = 50000;

export async function openSession({ tenantId, branchId, userId, terminalId = 'terminal-1', openingFloatCents = 0 }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;
  const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId));

  return await runWithContext({ tenantId: tid }, async () => {
    const existing = await CashSession.findOne({
      tenantId: tid,
      branchId: bid,
      userId: uid,
      status: 'open',
    });

    if (existing) {
      throw conflict('An open cash drawer session already exists for this user at this branch', 'DRAWER_ALREADY_OPEN');
    }

    const floatCents = Math.max(0, Math.round(Number(openingFloatCents || 0)));

    const newSession = new CashSession({
      branchId: bid,
      userId: uid,
      terminalId: terminalId || 'terminal-1',
      status: 'open',
      openingFloatCents: floatCents,
      expectedCashCents: floatCents,
      cashSalesCents: 0,
      cashRefundsCents: 0,
      movements: [],
      openedAt: new Date(),
    });

    await newSession.save();

    await auditAdapter.record({
      action: 'pos.drawer_opened',
      entity: 'CashSession',
      entityId: newSession._id,
      after: { openingFloatCents: floatCents, terminalId },
      tenantId: tid,
      userId: uid,
    });

    return newSession;
  });
}

export async function getCurrentSession({ tenantId, userId, branchId }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;
  const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId));

  return await runWithContext({ tenantId: tid }, async () => {
    const query = { tenantId: tid, userId: uid, status: 'open' };
    if (bid) query.branchId = bid;
    return await CashSession.findOne(query);
  });
}

export async function recordCashMovement({ tenantId, sessionId, type, amountCents, reason, userId }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const sid = sessionId instanceof mongoose.Types.ObjectId ? sessionId : new mongoose.Types.ObjectId(String(sessionId));
  const uid = userId ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId))) : null;

  return await runWithContext({ tenantId: tid }, async () => {
    const session = await CashSession.findOne({ _id: sid, tenantId: tid });
    if (!session) throw notFound('Cash session not found');
    if (session.status !== 'open') throw badRequest('Cannot record movement on a closed session', 'SESSION_NOT_OPEN');

    if (!['cash_in', 'cash_out'].includes(type)) {
      throw badRequest('Movement type must be cash_in or cash_out', 'INVALID_MOVEMENT_TYPE');
    }

    const amt = Math.round(Number(amountCents || 0));
    if (amt <= 0) {
      throw badRequest('Movement amount must be greater than zero', 'INVALID_AMOUNT');
    }

    if (!reason || !String(reason).trim()) {
      throw badRequest('Reason is required for cash movements', 'REASON_REQUIRED');
    }

    session.movements.push({
      type,
      amountCents: amt,
      reason: String(reason).trim(),
      time: new Date(),
      userId: uid,
    });

    const totalCashIn = session.movements
      .filter((m) => m.type === 'cash_in')
      .reduce((sum, m) => sum + m.amountCents, 0);
    const totalCashOut = session.movements
      .filter((m) => m.type === 'cash_out')
      .reduce((sum, m) => sum + m.amountCents, 0);

    session.expectedCashCents = session.openingFloatCents + session.cashSalesCents - session.cashRefundsCents + totalCashIn - totalCashOut;

    await session.save();

    await auditAdapter.record({
      action: `pos.drawer_${type}`,
      entity: 'CashSession',
      entityId: session._id,
      after: { type, amountCents: amt, reason },
      tenantId: tid,
      userId: uid,
    });

    return session;
  });
}

export async function updateSessionCashSale({ tenantId, branchId, amountCents, isRefund = false, session = null, userId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;
  const amt = Math.round(Number(amountCents || 0));
  if (amt <= 0) return null;

  return await runWithContext({ tenantId: tid }, async () => {
    const query = { tenantId: tid, status: 'open' };
    if (bid) query.branchId = bid;
    if (userId) query.userId = userId;

    let targetSession = await CashSession.findOne(query).session(session);
    if (!targetSession && userId) {
      delete query.userId;
      targetSession = await CashSession.findOne(query).session(session);
    }

    if (!targetSession) return null;

    if (isRefund) {
      targetSession.cashRefundsCents = (targetSession.cashRefundsCents || 0) + amt;
    } else {
      targetSession.cashSalesCents = (targetSession.cashSalesCents || 0) + amt;
    }

    const totalCashIn = targetSession.movements
      .filter((m) => m.type === 'cash_in')
      .reduce((s, m) => s + m.amountCents, 0);
    const totalCashOut = targetSession.movements
      .filter((m) => m.type === 'cash_out')
      .reduce((s, m) => s + m.amountCents, 0);

    targetSession.expectedCashCents =
      targetSession.openingFloatCents + targetSession.cashSalesCents - targetSession.cashRefundsCents + totalCashIn - totalCashOut;

    await targetSession.save({ session });
    return targetSession;
  });
}

export async function closeSession({
  tenantId,
  sessionId,
  countedCashCents,
  denominations = {},
  managerPin = null,
  userId = null,
  toleranceCents = DEFAULT_VARIANCE_TOLERANCE_CENTS,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const sid = sessionId instanceof mongoose.Types.ObjectId ? sessionId : new mongoose.Types.ObjectId(String(sessionId));

  return await runWithContext({ tenantId: tid }, async () => {
    const cashSession = await CashSession.findOne({ _id: sid, tenantId: tid });
    if (!cashSession) throw notFound('Cash session not found');
    if (cashSession.status !== 'open') throw badRequest('Session is already closed', 'SESSION_ALREADY_CLOSED');

    const counted = Math.max(0, Math.round(Number(countedCashCents ?? 0)));
    const totalCashIn = cashSession.movements
      .filter((m) => m.type === 'cash_in')
      .reduce((s, m) => s + m.amountCents, 0);
    const totalCashOut = cashSession.movements
      .filter((m) => m.type === 'cash_out')
      .reduce((s, m) => s + m.amountCents, 0);

    const expected = cashSession.openingFloatCents + cashSession.cashSalesCents - cashSession.cashRefundsCents + totalCashIn - totalCashOut;
    const variance = counted - expected;
    const absVariance = Math.abs(variance);

    let approvedBy = null;
    let requiresApproval = false;

    if (absVariance > toleranceCents) {
      requiresApproval = true;
      if (!managerPin) {
        throw forbidden(
          `Drawer variance of ${Math.abs(variance)} cents exceeds tolerance of ${toleranceCents} cents. Manager approval PIN required.`,
          'VARIANCE_REQUIRES_APPROVAL'
        );
      }
      const pinVerify = await verifyApprovalPin(tid, managerPin);
      if (!pinVerify.approved) {
        throw forbidden('Invalid manager approval PIN for drawer variance', 'INVALID_MANAGER_PIN');
      }
      approvedBy = pinVerify.approver?._id || null;
    }

    const now = new Date();
    const finalStatus = requiresApproval && approvedBy ? 'approved' : 'closed';

    const zReport = {
      reportId: `Z-${Date.now().toString(36).toUpperCase()}`,
      sessionId: cashSession._id,
      terminalId: cashSession.terminalId,
      openedAt: cashSession.openedAt,
      closedAt: now,
      openingFloatCents: cashSession.openingFloatCents,
      cashSalesCents: cashSession.cashSalesCents,
      cashRefundsCents: cashSession.cashRefundsCents,
      netCashSalesCents: cashSession.cashSalesCents - cashSession.cashRefundsCents,
      cashInCents: totalCashIn,
      cashOutCents: totalCashOut,
      expectedCashCents: expected,
      countedCashCents: counted,
      varianceCents: variance,
      denominations,
      requiresApproval,
      approvedBy,
      movementsCount: cashSession.movements.length,
    };

    cashSession.status = finalStatus;
    cashSession.expectedCashCents = expected;
    cashSession.countedCashCents = counted;
    cashSession.denominations = denominations;
    cashSession.varianceCents = variance;
    cashSession.requiresApproval = requiresApproval;
    cashSession.approvedBy = approvedBy;
    cashSession.closedAt = now;
    cashSession.zReport = zReport;

    await cashSession.save();

    await auditAdapter.record({
      action: 'pos.drawer_closed',
      entity: 'CashSession',
      entityId: cashSession._id,
      after: {
        status: finalStatus,
        countedCashCents: counted,
        expectedCashCents: expected,
        varianceCents: variance,
        approvedBy,
      },
      tenantId: tid,
      userId: userId || cashSession.userId,
    });

    return cashSession;
  });
}

export async function depositDrawerToBank({ tenantId, branchId, sessionId, bankAccountId, amountCents, userId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const sid = sessionId instanceof mongoose.Types.ObjectId ? sessionId : new mongoose.Types.ObjectId(String(sessionId));
  const baId = bankAccountId instanceof mongoose.Types.ObjectId ? bankAccountId : new mongoose.Types.ObjectId(String(bankAccountId));

  return await runWithContext({ tenantId: tid }, async () => {
    const cashSession = await CashSession.findOne({ _id: sid, tenantId: tid });
    if (!cashSession) throw notFound('Cash session not found');
    if (cashSession.status !== 'open') throw badRequest('Session must be open to deposit cash', 'SESSION_NOT_OPEN');

    const bankAccount = await BankAccount.findOne({ _id: baId, tenantId: tid, isActive: true });
    if (!bankAccount) throw notFound('Active bank account not found');

    const amt = Math.round(Number(amountCents || 0));
    if (amt <= 0) throw badRequest('Deposit amount must be greater than zero', 'INVALID_AMOUNT');

    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        cashSession.movements.push({
          type: 'cash_out',
          amountCents: amt,
          reason: `Deposit to ${bankAccount.bankName} (${bankAccount.accountNumber})`,
          time: new Date(),
          userId,
        });

        const totalCashIn = cashSession.movements
          .filter((m) => m.type === 'cash_in')
          .reduce((s, m) => s + m.amountCents, 0);
        const totalCashOut = cashSession.movements
          .filter((m) => m.type === 'cash_out')
          .reduce((s, m) => s + m.amountCents, 0);

        cashSession.expectedCashCents =
          cashSession.openingFloatCents + cashSession.cashSalesCents - cashSession.cashRefundsCents + totalCashIn - totalCashOut;

        await cashSession.save({ session });

        bankAccount.balanceCents = (bankAccount.balanceCents || 0) + amt;
        await bankAccount.save({ session });

        await ledgerService.postBankDeposit({
          tenantId: tid,
          branchId: branchId || cashSession.branchId,
          amountCents: amt,
          depositId: `${cashSession._id}-${Date.now()}`,
          createdBy: userId,
          session,
        });

        await auditAdapter.record({
          action: 'pos.bank_deposit',
          entity: 'BankAccount',
          entityId: bankAccount._id,
          after: { amountCents: amt, bankAccountId: bankAccount._id, sessionId: cashSession._id },
          tenantId: tid,
          userId,
        });

        return { cashSession, bankAccount };
      });
    } finally {
      session.endSession();
    }
  });
}

export async function recordCheque({ tenantId, branchId, data, userId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  return await runWithContext({ tenantId: tid }, async () => {
    const { chequeNumber, bankName, amountCents, partyName, customerId, invoiceId, maturityDate } = data;

    if (!chequeNumber || !bankName || !partyName || !maturityDate) {
      throw badRequest('Cheque number, bank name, party name, and maturity date are required', 'MISSING_FIELDS');
    }

    const amt = Math.round(Number(amountCents || 0));
    if (amt <= 0) throw badRequest('Cheque amount must be greater than zero', 'INVALID_AMOUNT');

    const existing = await Cheque.findOne({ tenantId: tid, bankName: bankName.trim(), chequeNumber: chequeNumber.trim() });
    if (existing) {
      throw conflict(`Cheque #${chequeNumber} for ${bankName} already exists`, 'CHEQUE_ALREADY_EXISTS');
    }

    const cheque = new Cheque({
      branchId: bid,
      chequeNumber: String(chequeNumber).trim(),
      bankName: String(bankName).trim(),
      amountCents: amt,
      partyName: String(partyName).trim(),
      customerId: customerId || null,
      invoiceId: invoiceId || null,
      maturityDate: new Date(maturityDate),
      status: 'pending',
      createdBy: userId,
    });

    await cheque.save();

    await auditAdapter.record({
      action: 'pos.cheque_recorded',
      entity: 'Cheque',
      entityId: cheque._id,
      after: { chequeNumber: cheque.chequeNumber, amountCents: amt, partyName: cheque.partyName },
      tenantId: tid,
      userId,
    });

    return cheque;
  });
}

export async function updateChequeStatus({ tenantId, chequeId, status, reason = null, userId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const chkId = chequeId instanceof mongoose.Types.ObjectId ? chequeId : new mongoose.Types.ObjectId(String(chequeId));

  return await runWithContext({ tenantId: tid }, async () => {
    const cheque = await Cheque.findOne({ _id: chkId, tenantId: tid });
    if (!cheque) throw notFound('Cheque not found');

    const validTransitions = ['pending', 'deposited', 'cleared', 'bounced', 'cancelled'];
    if (!validTransitions.includes(status)) {
      throw badRequest(`Invalid cheque status: ${status}`, 'INVALID_STATUS');
    }

    const previousStatus = cheque.status;
    cheque.status = status;

    if (status === 'cleared') {
      cheque.clearedAt = new Date();
      await cheque.save();
    } else if (status === 'bounced') {
      cheque.bouncedReason = reason || 'Cheque bounced';

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (cheque.customerId) {
            const customer = await Customer.findOne({ _id: cheque.customerId, tenantId: tid }).session(session);
            if (customer) {
              customer.currentBalanceCents = (customer.currentBalanceCents || 0) + cheque.amountCents;
              await customer.save({ session });
            }
          }

          if (cheque.invoiceId) {
            const inv = await Invoice.findOne({ _id: cheque.invoiceId, tenantId: tid }).session(session);
            if (inv && inv.paymentStatus === 'paid') {
              inv.paymentStatus = 'partially_paid';
              await inv.save({ session });
            }
          }

          await ledgerService.postChequeBounce({
            tenantId: tid,
            branchId: cheque.branchId,
            amountCents: cheque.amountCents,
            chequeNumber: cheque.chequeNumber,
            reason: cheque.bouncedReason,
            createdBy: userId,
            session,
          });

          await cheque.save({ session });
        });
      } finally {
        session.endSession();
      }
    } else {
      await cheque.save();
    }

    await auditAdapter.record({
      action: 'pos.cheque_status_updated',
      entity: 'Cheque',
      entityId: cheque._id,
      before: { status: previousStatus },
      after: { status, reason },
      tenantId: tid,
      userId,
    });

    return cheque;
  });
}

export async function recordExpense({ tenantId, branchId, data, userId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  return await runWithContext({ tenantId: tid }, async () => {
    const { category, amountCents, paymentMethod = 'cash', bankAccountId = null, payee, notes = '', receiptUrl = null } = data;

    if (!category || !payee) throw badRequest('Category and payee are required', 'MISSING_FIELDS');
    const amt = Math.round(Number(amountCents || 0));
    if (amt <= 0) throw badRequest('Expense amount must be greater than zero', 'INVALID_AMOUNT');

    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        let baDoc = null;
        if (paymentMethod === 'bank' && bankAccountId) {
          baDoc = await BankAccount.findOne({ _id: bankAccountId, tenantId: tid }).session(session);
          if (baDoc) {
            baDoc.balanceCents = (baDoc.balanceCents || 0) - amt;
            await baDoc.save({ session });
          }
        }

        const exp = new Expense({
          branchId: bid,
          category: String(category).trim(),
          amountCents: amt,
          paymentMethod,
          bankAccountId: baDoc ? baDoc._id : null,
          payee: String(payee).trim(),
          notes: notes ? String(notes).trim() : '',
          receiptUrl: receiptUrl || null,
          createdBy: userId,
          date: new Date(),
        });

        await exp.save({ session });

        await ledgerService.postExpense({
          tenantId: tid,
          branchId: bid,
          amountCents: amt,
          paymentMethod,
          category: exp.category,
          payee: exp.payee,
          expenseId: exp._id,
          createdBy: userId,
          session,
        });

        await auditAdapter.record({
          action: 'pos.expense_recorded',
          entity: 'Expense',
          entityId: exp._id,
          after: { category: exp.category, amountCents: amt, payee: exp.payee, paymentMethod },
          tenantId: tid,
          userId,
        });

        return exp;
      });
    } finally {
      session.endSession();
    }
  });
}

export async function getDayEndReport({ tenantId, branchId, date = new Date() }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  return await runWithContext({ tenantId: tid }, async () => {
    const targetDate = new Date(date);
    const startOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 23, 59, 59, 999));

    const sessionQuery = {
      tenantId: tid,
      openedAt: { $gte: startOfDay, $lte: endOfDay },
    };
    if (bid) sessionQuery.branchId = bid;

    const sessions = await CashSession.find(sessionQuery).populate('userId', 'name email').lean();

    const invoiceQuery = {
      tenantId: tid,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ['completed', 'partially_returned', 'returned'] },
    };
    if (bid) invoiceQuery.branchId = bid;

    const invoices = await Invoice.find(invoiceQuery).lean();

    let totalOpeningFloatCents = 0;
    let totalCashSalesCents = 0;
    let totalCashRefundsCents = 0;
    let totalCashInCents = 0;
    let totalCashOutCents = 0;
    let totalExpectedCashCents = 0;
    let totalCountedCashCents = 0;
    let totalVarianceCents = 0;

    for (const s of sessions) {
      totalOpeningFloatCents += s.openingFloatCents || 0;
      totalCashSalesCents += s.cashSalesCents || 0;
      totalCashRefundsCents += s.cashRefundsCents || 0;
      totalExpectedCashCents += s.expectedCashCents || 0;
      totalCountedCashCents += s.countedCashCents || 0;
      totalVarianceCents += s.varianceCents || 0;

      for (const m of s.movements || []) {
        if (m.type === 'cash_in') totalCashInCents += m.amountCents;
        if (m.type === 'cash_out') totalCashOutCents += m.amountCents;
      }
    }

    let totalSalesGrossCents = 0;
    for (const inv of invoices) {
      totalSalesGrossCents += inv.grandTotalCents || 0;
    }

    return {
      date: startOfDay.toISOString().slice(0, 10),
      branchId: bid,
      sessionsCount: sessions.length,
      closedSessionsCount: sessions.filter((s) => ['closed', 'approved'].includes(s.status)).length,
      totals: {
        openingFloatCents: totalOpeningFloatCents,
        cashSalesCents: totalCashSalesCents,
        cashRefundsCents: totalCashRefundsCents,
        netCashSalesCents: totalCashSalesCents - totalCashRefundsCents,
        cashInCents: totalCashInCents,
        cashOutCents: totalCashOutCents,
        expectedCashCents: totalExpectedCashCents,
        countedCashCents: totalCountedCashCents,
        varianceCents: totalVarianceCents,
        invoicesTotalCents: totalSalesGrossCents,
        invoiceCount: invoices.length,
      },
      sessions: sessions.map((s) => ({
        _id: s._id,
        terminalId: s.terminalId,
        user: s.userId ? { _id: s.userId._id, name: s.userId.name } : null,
        status: s.status,
        openingFloatCents: s.openingFloatCents,
        cashSalesCents: s.cashSalesCents,
        countedCashCents: s.countedCashCents,
        varianceCents: s.varianceCents,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
      })),
    };
  });
}

export default {
  openSession,
  getCurrentSession,
  recordCashMovement,
  updateSessionCashSale,
  closeSession,
  depositDrawerToBank,
  recordCheque,
  updateChequeStatus,
  recordExpense,
  getDayEndReport,
  DEFAULT_VARIANCE_TOLERANCE_CENTS,
};