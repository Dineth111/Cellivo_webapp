import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import { wrap, badRequest } from '../../../core/errors.js';
import { requirePermission } from '../../../core/permissions.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import { resolveBranch } from '../utils/branch.js';
import * as ledgerService from '../services/ledger.service.js';

const router = express.Router();

// Guard with session authentication and tenant subscription status
router.use(protect, subscriptionGuard);

/**
 * POST /api/pos/ledger/journal
 * Accepts journal lines and invokes postJournal (used by POS, Dev 4 Purchasing & Dev 5 Repairs).
 */
router.post(
  '/journal',
  requirePermission('finance.create'),
  wrap(async (req, res) => {
    const { referenceType, referenceId, description, lines } = req.body;
    if (!referenceType) {
      throw badRequest('referenceType is required', 'MISSING_FIELD');
    }
    if (!lines || !Array.isArray(lines)) {
      throw badRequest('lines array is required', 'MISSING_FIELD');
    }

    const entry = await ledgerService.postJournal({
      tenantId: req.auth.tenantId,
      branchId: (await resolveBranch(req))._id,
      referenceType,
      referenceId,
      description,
      lines,
      createdBy: req.auth.userId,
    });

    await auditAdapter.record({
      action: 'ledger.manual_journal',
      entity: 'LedgerEntry',
      entityId: entry._id,
      after: { entryNumber: entry.entryNumber, referenceType, referenceId, description, lines: entry.lines },
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });

    res.status(201).json({
      success: true,
      message: 'Journal entry posted successfully',
      data: entry,
    });
  })
);

/**
 * GET /api/pos/ledger/balances
 * Returns account balances for the current tenant.
 */
router.get(
  '/balances',
  requirePermission('finance.view'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req, { allowAll: true }))?._id ?? null;
    const balances = await ledgerService.getAccountBalances(req.auth.tenantId, branchId);

    res.json({
      success: true,
      data: balances,
    });
  })
);

export default router;
