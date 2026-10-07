import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard, requireFeature } from '../../plans/planLimits.js';
import { requirePermission } from '../../../core/permissions.js';
import { wrap } from '../../../core/errors.js';
import { resolveBranch } from '../utils/branch.js';
import * as returnService from '../services/return.service.js';

const router = express.Router();

// Plan Gating: Returns and wholesale require the Starter plan or higher (F-10 / V-10)
router.use(protect, subscriptionGuard, requireFeature('returns_wholesale'));

/**
 * GET /lookup/:invoiceNumber
 * Retrieves an invoice and determines eligible return items and quantities.
 */
router.get(
  '/lookup/:invoiceNumber',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const data = await returnService.getInvoiceForReturn({
      tenantId: req.auth.tenantId,
      invoiceNumber: req.params.invoiceNumber,
    });

    res.json({
      success: true,
      data,
    });
  })
);

/**
 * POST /
 * Processes an item return and generates a CreditNote document.
 */
router.post(
  '/',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;

    const creditNote = await returnService.processReturn({
      tenantId: req.auth.tenantId,
      branchId,
      userId: req.auth.userId,
      userRole: req.auth.role,
      permissions: req.auth.role?.grid || {},
      data: req.body,
    });

    res.status(201).json({
      success: true,
      message: 'Return processed and Credit Note issued successfully',
      data: creditNote,
    });
  })
);

/**
 * POST /exchange
 * Processes an atomic exchange combining return and new purchase.
 */
router.post(
  '/exchange',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;

    const result = await returnService.processExchange({
      tenantId: req.auth.tenantId,
      branchId,
      userId: req.auth.userId,
      userRole: req.auth.role,
      permissions: req.auth.role?.grid || {},
      data: req.body,
    });

    res.status(201).json({
      success: true,
      message: 'Exchange processed successfully',
      data: result,
    });
  })
);

export default router;
