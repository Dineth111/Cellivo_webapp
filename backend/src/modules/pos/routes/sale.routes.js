import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import { requirePermission, requireSpecial } from '../../../core/permissions.js';
import { wrap, badRequest } from '../../../core/errors.js';
import * as saleService from '../services/sale.service.js';
import * as stockAdapter from '../adapters/stock.adapter.js';
import HeldCart from '../models/HeldCart.model.js';
import Invoice from '../models/Invoice.model.js';
import Quotation from '../models/Quotation.model.js';
import { resolveBranch, resolveRecordBranch } from '../utils/branch.js';

const router = express.Router();

router.use(protect, subscriptionGuard);

/**
 * GET /items/lookup
 * Look up items by barcode, IMEI, or search query.
 */
router.get(
  '/items/lookup',
  wrap(async (req, res) => {
    const { barcode, imei, q } = req.query;
    const branchId = (await resolveBranch(req))._id;

    if (imei) {
      const item = await stockAdapter.lookupImei(req.auth.tenantId, branchId, String(imei).trim());
      return res.json({ success: true, data: item });
    }

    if (barcode) {
      const item = await stockAdapter.lookupByBarcode(req.auth.tenantId, branchId, String(barcode).trim());
      return res.json({ success: true, data: item });
    }

    if (q) {
      const items = await stockAdapter.searchProducts(req.auth.tenantId, branchId, String(q).trim());
      return res.json({ success: true, data: items });
    }

    throw badRequest('Please provide barcode, imei, or query (q) parameter', 'MISSING_PARAM');
  })
);

/**
 * POST /cart/calculate
 * Calculate line and grand totals without completing or saving.
 */
router.post(
  '/cart/calculate',
  wrap(async (req, res) => {
    const totals = saleService.calculateCartTotals(req.body);
    res.json({ success: true, data: totals });
  })
);

/**
 * POST /checkout
 * Complete sale (idempotent, atomic transaction).
 */
router.post(
  '/checkout',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey || null;
    const branchId = (await resolveBranch(req))._id;

    const invoice = await saleService.completeSale({
      tenantId: req.auth.tenantId,
      branchId,
      userId: req.auth.userId,
      userRole: req.auth.role,
      discountLimitPercent: req.auth.discountLimit,
      permissions: req.auth.role?.grid,
      data: req.body,
      idempotencyKey,
    });

    res.status(201).json({
      success: true,
      message: 'Sale completed successfully',
      data: invoice,
    });
  })
);

/**
 * POST /cart/hold
 * Holds the current cart and reserves IMEIs.
 */
router.post(
  '/cart/hold',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;
    const { cartName, customer, lines, discounts } = req.body;

    const held = await saleService.holdCart({
      tenantId: req.auth.tenantId,
      branchId,
      cartName,
      customer,
      lines,
      discounts,
      heldBy: req.auth.userId,
    });

    res.status(201).json({
      success: true,
      message: 'Cart held successfully',
      data: held,
    });
  })
);

/**
 * GET /cart/held
 * Lists active held carts.
 */
router.get(
  '/cart/held',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;
    const query = { expiresAt: { $gt: new Date() } };
    query.branchId = branchId;

    const carts = await HeldCart.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: carts });
  })
);

/**
 * POST /cart/resume/:id
 * Resumes and removes a held cart.
 */
router.post(
  '/cart/resume/:id',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveRecordBranch(req, HeldCart, req.params.id, 'Held cart'))._id;
    const cart = await saleService.resumeCart({
      tenantId: req.auth.tenantId,
      branchId,
      heldCartId: req.params.id,
    });

    res.json({ success: true, message: 'Cart resumed', data: cart });
  })
);

/**
 * GET /invoices/:id
 * Retrieves a populated invoice for viewing, printing, and reprints.
 */
router.get(
  '/invoices/:id',
  requirePermission('pos.view'),
  wrap(async (req, res) => {
    (await resolveRecordBranch(req, Invoice, req.params.id, 'Invoice'))._id;
    const invoice = await saleService.getInvoiceById({
      tenantId: req.auth.tenantId,
      invoiceId: req.params.id,
      userRole: req.auth.role,
    });

    res.json({
      success: true,
      data: invoice,
    });
  })
);

/**
 * POST /invoices/:id/void
 * Voids a completed invoice (guarded by void_invoice special permission).
 */
router.post(
  '/invoices/:id/void',
  requireSpecial('void_invoice'),
  wrap(async (req, res) => {
    const { reason } = req.body;
    const branchId = (await resolveRecordBranch(req, Invoice, req.params.id, 'Invoice'))._id;

    const voided = await saleService.voidInvoice({
      tenantId: req.auth.tenantId,
      branchId,
      invoiceId: req.params.id,
      reason,
      userId: req.auth.userId,
      userRole: req.auth.role,
    });

    res.json({
      success: true,
      message: 'Invoice voided successfully',
      data: voided,
    });
  })
);

/**
 * POST /quotations
 * Creates a quotation.
 */
router.post(
  '/quotations',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveBranch(req))._id;
    const { customerId, lines, invoiceDiscountPercent, taxRatePercent, validDays } = req.body;

    const quote = await saleService.createQuotation({
      tenantId: req.auth.tenantId,
      branchId,
      customerId,
      lines,
      invoiceDiscountPercent,
      taxRatePercent,
      createdBy: req.auth.userId,
      validDays,
    });

    res.status(201).json({
      success: true,
      message: 'Quotation created successfully',
      data: quote,
    });
  })
);

/**
 * POST /quotations/:id/convert
 * Converts a quotation to a completed invoice.
 */
router.post(
  '/quotations/:id/convert',
  requirePermission('pos.create'),
  wrap(async (req, res) => {
    const branchId = (await resolveRecordBranch(req, Quotation, req.params.id, 'Quotation'))._id;
    const { payments } = req.body;

    const invoice = await saleService.convertQuotationToInvoice({
      tenantId: req.auth.tenantId,
      branchId,
      quotationId: req.params.id,
      userId: req.auth.userId,
      userRole: req.auth.role,
      payments,
    });

    res.status(201).json({
      success: true,
      message: 'Quotation converted to invoice successfully',
      data: invoice,
    });
  })
);

export default router;
