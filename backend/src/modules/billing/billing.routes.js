import express from 'express';
import Tenant from '../tenants/Tenant.model.js';
import Branch from '../branches/Branch.model.js';
import Customer from '../customers/Customer.model.js';
import { Invoice, Notice } from './billing.models.js';
import { protect } from '../../core/auth.js';
import { requireOwner } from '../../core/permissions.js';
import { wrap, badRequest, notFound } from '../../core/errors.js';
import { str, requireId } from '../../core/validate.js';
import audit from '../../core/audit.js';
import * as billing from './billing.service.js';
import { portalSummary } from './portal.service.js';
import { listPlans } from '../plans/plans.service.js';
import { invoicePdf } from './invoicePdf.js';

/**
 * Billing API (FRS F-02, F-20). Owner only. NOT behind subscriptionGuard: a suspended shop must
 * still be able to see, pay and export (V-11).
 */
const router = express.Router();
router.use(protect, requireOwner);

const loadTenant = (req) => Tenant.findById(req.tenant._id).select('+paymentMethod.token');
const purchase = (b = {}) => ({ planCode: str(b.planCode), term: str(b.term), currency: str(b.currency)?.toUpperCase(), couponCode: str(b.couponCode) || undefined, card: { number: str(b.card?.number) } });

// GET /api/billing/summary: the portal home (ACC-11 to ACC-18)
router.get('/summary', wrap(async (req, res) => {
  res.json({ success: true, data: await portalSummary(req.tenant, req.user) });
}));

// GET /api/billing/plans: plans with prices for the plan picker
router.get('/plans', wrap(async (req, res) => {
  res.json({ success: true, data: await listPlans({ visibleOnly: true }) });
}));

// POST /api/billing/quote {planCode, term, currency?, couponCode?}: price, proration credit, amount due today
router.post('/quote', wrap(async (req, res) => {
  const b = purchase(req.body);
  if (!b.planCode || !b.term) throw badRequest('Choose a plan and a billing term');
  res.json({ success: true, data: billing.publicQuote(await billing.quote(req.tenant, b)) });
}));

// POST /api/billing/subscribe {planCode, term, currency?, couponCode?, card?:{number}}
router.post('/subscribe', wrap(async (req, res) => {
  const b = purchase(req.body);
  if (!b.planCode || !b.term) throw badRequest('Choose a plan and a billing term');
  const tenant = await loadTenant(req);
  const out = await billing.subscribe(tenant, b);
  res.status(out.scheduled ? 200 : 201).json({
    success: true,
    message: out.scheduled ? 'Your plan will change at the next renewal.' : 'Payment received. Your plan is active.',
    data: { quote: out.quote, scheduled: !!out.scheduled, invoiceId: out.invoice?._id, invoiceNumber: out.invoice?.number },
  });
}));

// POST /api/billing/cancel | /undo-cancel
router.post('/cancel', wrap(async (req, res) => {
  await billing.cancel(await loadTenant(req));
  res.json({ success: true, message: 'Your subscription is cancelled. You keep access until the paid period ends.' });
}));
router.post('/undo-cancel', wrap(async (req, res) => {
  await billing.undoCancel(await loadTenant(req));
  res.json({ success: true, message: 'Cancellation removed.' });
}));

// PUT /api/billing/payment-method {number}: replaces the saved card (ACC-09)
router.put('/payment-method', wrap(async (req, res) => {
  const tenant = await loadTenant(req);
  await billing.setPaymentMethod(tenant, { number: str(req.body?.number) });
  await tenant.save();
  await audit.record({ action: 'billing.payment_method', entity: 'Tenant', entityId: tenant._id, after: { last4: tenant.paymentMethod.last4 } });
  res.json({ success: true, data: { brand: tenant.paymentMethod.brand, last4: tenant.paymentMethod.last4 } });
}));

// PUT /api/billing/details {name?, address?, taxNumber?}: printed on invoices
router.put('/details', wrap(async (req, res) => {
  const tenant = await loadTenant(req);
  for (const k of ['name', 'address', 'taxNumber']) if (str(req.body?.[k]) !== undefined) tenant.billingDetails[k] = str(req.body[k]);
  await tenant.save();
  await audit.record({ action: 'billing.details', entity: 'Tenant', entityId: tenant._id, after: tenant.billingDetails });
  res.json({ success: true, data: tenant.billingDetails });
}));

// GET /api/billing/invoices, GET /api/billing/invoices/:id/pdf
router.get('/invoices', wrap(async (req, res) => {
  const data = await Invoice.find({ tenantId: req.tenant._id }).sort({ paidAt: -1 }).limit(200).lean();
  res.json({ success: true, count: data.length, data });
}));
router.get('/invoices/:id/pdf', wrap(async (req, res) => {
  requireId(req.params.id, 'invoice id');
  const inv = await Invoice.findOne({ _id: req.params.id, tenantId: req.tenant._id }); // other shops' invoices: 404
  if (!inv) throw notFound('Invoice not found');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.number}.pdf"` }).send(invoicePdf(inv));
}));

// POST /api/billing/affiliate/dismiss: hide the banner for 90 days (FRS 7.2)
router.post('/affiliate/dismiss', wrap(async (req, res) => {
  await Tenant.updateOne({ _id: req.tenant._id }, { affiliateBannerHiddenUntil: new Date(Date.now() + 90 * 864e5) });
  res.json({ success: true });
}));

// POST /api/billing/notices/read
router.post('/notices/read', wrap(async (req, res) => {
  await Notice.updateMany({ tenantId: req.tenant._id, readAt: null }, { readAt: new Date() });
  res.json({ success: true });
}));

// GET /api/billing/export: all shop data before cancelling (ACC-10). Works for suspended shops too.
// ponytail: JSON of what exists today (shop, branches, customers). Other modules add their collections here.
router.get('/export', wrap(async (req, res) => {
  const [branches, customers] = await Promise.all([Branch.find().lean(), Customer.find().lean()]);
  const body = { exportedAt: new Date(), shop: { name: req.tenant.name, country: req.tenant.country }, branches, customers };
  await audit.record({ action: 'billing.export', entity: 'Tenant', entityId: req.tenant._id });
  res.set('Content-Disposition', 'attachment; filename="cellivo-export.json"').json(body);
}));

export default router;
