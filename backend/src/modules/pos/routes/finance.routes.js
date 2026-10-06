import { Router } from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import * as financeService from '../services/finance.service.js';
import BankAccount from '../models/BankAccount.model.js';
import Cheque from '../models/Cheque.model.js';
import Expense from '../models/Expense.model.js';
import CashSession from '../models/CashSession.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';

const router = Router();

router.use(protect);
router.use(subscriptionGuard);

// -------------------------------------------------------------
// Drawer Session Lifecycle
// -------------------------------------------------------------

// POST /api/pos/finance/drawer/open
router.post('/drawer/open', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.headers['x-branch-id'] || req.body.branchId || req.auth.branchIds?.[0] || req.user.branchId || null;
    const userId = req.user._id;
    const { openingFloatCents, terminalId } = req.body;

    const session = await financeService.openSession({
      tenantId,
      branchId,
      userId,
      terminalId,
      openingFloatCents,
    });

    res.status(201).json({ status: 'success', data: session });
  } catch (err) {
    next(err);
  }
});

// GET /api/pos/finance/drawer/current
router.get('/drawer/current', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || req.auth.branchIds?.[0] || req.user.branchId || null;
    const userId = req.user._id;

    const session = await financeService.getCurrentSession({
      tenantId,
      userId,
      branchId,
    });

    res.json({ status: 'success', data: session || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/drawer/movement
router.post('/drawer/movement', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user._id;
    const { sessionId, type, amountCents, reason } = req.body;

    const session = await financeService.recordCashMovement({
      tenantId,
      sessionId,
      type,
      amountCents,
      reason,
      userId,
    });

    res.json({ status: 'success', data: session });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/drawer/close
router.post('/drawer/close', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user._id;
    const { sessionId, countedCashCents, denominations, managerPin } = req.body;

    const session = await financeService.closeSession({
      tenantId,
      sessionId,
      countedCashCents,
      denominations,
      managerPin,
      userId,
    });

    res.json({ status: 'success', data: session });
  } catch (err) {
    next(err);
  }
});

// GET /api/pos/finance/drawer/z-report/:sessionId
router.get('/drawer/z-report/:sessionId', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { sessionId } = req.params;

    const session = await runWithContext({ tenantId }, async () => {
      return await CashSession.findOne({ _id: sessionId, tenantId });
    });

    if (!session) throw notFound('Cash session not found');
    if (!session.zReport) throw badRequest('Z-Report has not been generated for this session', 'Z_REPORT_NOT_FOUND');

    res.json({ status: 'success', data: session.zReport });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Banking & Accounts
// -------------------------------------------------------------

// GET /api/pos/finance/banking/accounts
router.get('/banking/accounts', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const accounts = await runWithContext({ tenantId }, async () => {
      return await BankAccount.find({ tenantId, isActive: true }).sort({ bankName: 1 });
    });
    res.json({ status: 'success', data: accounts });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/banking/accounts
router.post('/banking/accounts', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.user.branchId || null;
    const { accountName, bankName, accountNumber, balanceCents } = req.body;

    if (!accountName || !bankName || !accountNumber) {
      throw badRequest('Account name, bank name, and account number are required');
    }

    const created = await runWithContext({ tenantId }, async () => {
      const acc = new BankAccount({
        branchId,
        accountName: String(accountName).trim(),
        bankName: String(bankName).trim(),
        accountNumber: String(accountNumber).trim(),
        balanceCents: Math.round(Number(balanceCents || 0)),
      });
      await acc.save();
      return acc;
    });

    res.status(201).json({ status: 'success', data: created });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/banking/deposit
router.post('/banking/deposit', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.user.branchId || null;
    const userId = req.user._id;
    const { sessionId, bankAccountId, amountCents } = req.body;

    const result = await financeService.depositDrawerToBank({
      tenantId,
      branchId,
      sessionId,
      bankAccountId,
      amountCents,
      userId,
    });

    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Cheques Management
// -------------------------------------------------------------

// GET /api/pos/finance/cheques
router.get('/cheques', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { status, customerId } = req.query;

    const cheques = await runWithContext({ tenantId }, async () => {
      const q = { tenantId };
      if (status) q.status = status;
      if (customerId) q.customerId = customerId;
      return await Cheque.find(q).sort({ maturityDate: 1 }).populate('customerId', 'name phone');
    });

    res.json({ status: 'success', data: cheques });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/cheques
router.post('/cheques', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.user.branchId || null;
    const userId = req.user._id;

    const cheque = await financeService.recordCheque({
      tenantId,
      branchId,
      data: req.body,
      userId,
    });

    res.status(201).json({ status: 'success', data: cheque });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/pos/finance/cheques/:id/status
router.patch('/cheques/:id/status', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user._id;
    const { id } = req.params;
    const { status, reason } = req.body;

    const updated = await financeService.updateChequeStatus({
      tenantId,
      chequeId: id,
      status,
      reason,
      userId,
    });

    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Expenses
// -------------------------------------------------------------

// GET /api/pos/finance/expenses
router.get('/expenses', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { category, startDate, endDate } = req.query;

    const expenses = await runWithContext({ tenantId }, async () => {
      const q = { tenantId };
      if (category) q.category = category;
      if (startDate || endDate) {
        q.date = {};
        if (startDate) q.date.$gte = new Date(startDate);
        if (endDate) q.date.$lte = new Date(endDate);
      }
      return await Expense.find(q).sort({ date: -1 }).populate('createdBy', 'name email');
    });

    res.json({ status: 'success', data: expenses });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/finance/expenses
router.post('/expenses', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.user.branchId || null;
    const userId = req.user._id;

    const exp = await financeService.recordExpense({
      tenantId,
      branchId,
      data: req.body,
      userId,
    });

    res.status(201).json({ status: 'success', data: exp });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Day-End Report
// -------------------------------------------------------------

// GET /api/pos/finance/day-end
router.get('/day-end', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const branchId = req.user.branchId || req.query.branchId || null;
    const date = req.query.date ? new Date(req.query.date) : new Date();

    const report = await financeService.getDayEndReport({
      tenantId,
      branchId,
      date,
    });

    res.json({ status: 'success', data: report });
  } catch (err) {
    next(err);
  }
});

export default router;
