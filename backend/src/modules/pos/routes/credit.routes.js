import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard, requireFeature } from '../../plans/planLimits.js';
import { requirePermission } from '../../../core/permissions.js';
import { wrap } from '../../../core/errors.js';
import { resolveBranch } from '../utils/branch.js';
import * as creditService from '../services/credit.service.js';

const router = express.Router();

// Plan Gating: Credit sales and installments require Starter plan or above (F-11 / SRS 2.3)
router.use(protect, subscriptionGuard, requireFeature('credit'));

const eligibility = (req, requestedCreditCents, managerPin) =>
  creditService.checkCreditEligibility({
    tenantId: req.auth.tenantId,
    customerId: req.params.id,
    requestedCreditCents,
    managerPin,
    userId: req.auth.userId,
  });

/**
 * GET /customers/:id/eligibility?requestedAmountCents=
 * Checks customer credit limit and exposure. Never takes a PIN (URLs end up in logs).
 */
router.get(
  '/customers/:id/eligibility',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const requestedAmount = req.query.requestedAmountCents ? Number(req.query.requestedAmountCents) : 0;
    res.json({ success: true, data: await eligibility(req, requestedAmount, null) });
  })
);

/**
 * POST /customers/:id/eligibility { pin, amountCents }
 * Same check, with a manager approval PIN for going over the credit limit.
 */
router.post(
  '/customers/:id/eligibility',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const pin = typeof req.body.pin === 'string' ? req.body.pin : null;
    res.json({ success: true, data: await eligibility(req, Number(req.body.amountCents) || 0, pin) });
  })
);

/**
 * GET /customers/:id/aging
 * Returns aging breakdown (Current, 1-30, 31-60, 61-90, 90+ days) and pending installments.
 */
router.get(
  '/customers/:id/aging',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const data = await creditService.getCustomerAging({
      tenantId: req.auth.tenantId,
      customerId: req.params.id,
    });

    res.json({
      success: true,
      data,
    });
  })
);

/**
 * POST /payments
 * Records collections payment distributed to oldest-due installments first.
 */
router.post(
  '/payments',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;

    const result = await creditService.recordCustomerPayment({
      tenantId: req.auth.tenantId,
      branchId,
      customerId: req.body.customerId,
      amountCents: req.body.amountCents,
      paymentMethod: req.body.paymentMethod || 'cash',
      reference: req.body.reference,
      receivedBy: req.auth.userId,
    });

    res.status(201).json({
      success: true,
      message: 'Payment allocated and recorded successfully',
      data: result,
    });
  })
);

/**
 * GET /overdue
 * Returns all overdue installments across the branch/tenant.
 */
router.get(
  '/overdue',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req, { allowAll: true }))?._id ?? null;

    const list = await creditService.getOverdueInstallments({
      tenantId: req.auth.tenantId,
      branchId,
    });

    res.json({
      success: true,
      data: list,
    });
  })
);

/**
 * POST /remind/:planId/:installmentNo
 * Dispatches an automated SMS reminder.
 */
router.post(
  '/remind/:planId/:installmentNo',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const result = await creditService.sendInstallmentReminder({
      tenantId: req.auth.tenantId,
      installmentPlanId: req.params.planId,
      installmentNumber: req.params.installmentNo,
    });

    res.json({
      success: true,
      message: 'Reminder SMS dispatched successfully',
      data: result,
    });
  })
);

/**
 * POST /calculate-schedule
 * Utility endpoint to preview an installment schedule without saving.
 */
router.post(
  '/calculate-schedule',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const schedule = creditService.calculateSchedule({
      financedAmountCents: req.body.financedAmountCents,
      numberOfInstallments: req.body.numberOfInstallments,
      frequency: req.body.frequency,
      firstDueDate: req.body.firstDueDate,
    });

    res.json({
      success: true,
      data: schedule,
    });
  })
);

export default router;
