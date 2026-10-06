import express from 'express';
import Tenant, { TENANT_STATUSES } from '../tenants/Tenant.model.js';
import Branch from '../branches/Branch.model.js';
import User from '../users/User.model.js';
import Plan from '../plans/Plan.model.js';
import { Invoice, Payment, Coupon } from '../billing/billing.models.js';
import { AdminUser, AdminSession, AdminAudit, ADMIN_ROLES, platformAudit } from './admin.models.js';
import { Lead, Affiliate, Payout, SupportTicket, Announcement, EmailTemplate, CmsEntry, PhoneModel, FeatureFlag, Maintenance, SmsPackage } from '../growth/growth.models.js';
import { adminProtect, needs, login, enroll, verifyCode, publicAdmin } from './admin.auth.js';
import * as billing from '../billing/billing.service.js';
import { listPlans, ensurePlans } from '../plans/plans.service.js';
import { runAsPlatform } from '../../core/tenantContext.js';
import { hashPassword, passwordError } from '../../core/password.js';
import { wrap, badRequest, notFound, conflict } from '../../core/errors.js';
import { str, pick, requireId, pageParams, escapeRegex } from '../../core/validate.js';

/**
 * Platform admin API (FRS section 4, A-01 to A-16). Mounted at /api/admin. Every route needs an admin
 * session; every change is written to the platform audit log (ADM-27).
 */
const router = express.Router();
const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const DAY = 864e5;
const ctx = (req) => ({ admin: req.admin, ip: req.ip });

// ---- auth (no session yet) -------------------------------------------------------------------
router.post('/auth/login', wrap(async (req, res) => ok(res, await login(str(req.body?.email), req.body?.password, req.ip))));
router.post('/auth/enroll', wrap(async (req, res) => ok(res, await enroll(str(req.body?.challenge)))));
router.post('/auth/verify', wrap(async (req, res) =>
  ok(res, await verifyCode(str(req.body?.challenge), str(req.body?.code), { ip: req.ip, device: req.get('user-agent') || '' }))));

router.use(adminProtect);

router.get('/me', (req, res) => ok(res, publicAdmin(req.admin)));
router.post('/auth/logout', wrap(async (req, res) => {
  await AdminSession.updateOne({ _id: req.adminSession._id }, { revokedAt: new Date() });
  ok(res, null);
}));

// ---- dashboard (A-01) ------------------------------------------------------------------------
router.get('/dashboard', wrap(async (req, res) => {
  const since = new Date(Date.now() - 30 * DAY);
  const [byStatus, byPlan, revenue, failed, leads, tickets, trialsEnding3d] = await Promise.all([
    Tenant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Tenant.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$planCode', n: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { paidAt: { $gte: since }, status: { $ne: 'void' } } }, { $group: { _id: '$currency', total: { $sum: '$total' } } }]),
    Payment.countDocuments({ status: 'failed', createdAt: { $gte: since } }),
    Lead.countDocuments({ status: 'new' }),
    SupportTicket.countDocuments({ status: { $in: ['open', 'pending'] } }),
    Tenant.countDocuments({ status: 'trial', trialEndsAt: { $gte: new Date(), $lte: new Date(Date.now() + 3 * DAY) } }),
  ]);
  ok(res, {
    tenantsByStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
    activeByPlan: Object.fromEntries(byPlan.map((r) => [r._id ?? 'none', r.n])),
    revenueLast30Days: Object.fromEntries(revenue.map((r) => [r._id, r.total])), // minor units
    failedPayments30d: failed, trialsEnding3d, newLeads: leads, openTickets: tickets, lastBillingRun: billing.lastBillingRun(),
  });
}));

// ---- tenants (A-02, A-03) --------------------------------------------------------------------
router.get('/tenants', wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = {};
  const status = str(req.query.status);
  if (status) { if (!TENANT_STATUSES.includes(status)) throw badRequest('Unknown status'); q.status = status; }
  if (str(req.query.plan)) q.planCode = str(req.query.plan);
  const text = str(req.query.q);
  if (text) { const re = new RegExp(escapeRegex(text), 'i'); q.$or = [{ name: re }, { ownerEmail: re }, { ownerName: re }, { phone: re }]; }
  const [data, total] = await Promise.all([Tenant.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Tenant.countDocuments(q)]);
  ok(res, data, { page, total });
}));

const loadTenant = async (id) => {
  requireId(id, 'shop id');
  const t = await Tenant.findById(id).select('+paymentMethod.token');
  if (!t) throw notFound('Shop not found');
  return t;
};

router.get('/tenants/:id', wrap(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const [users, branches, invoices, payments] = await Promise.all([
    runAsPlatform(async () => await User.countDocuments({ tenantId: t._id })),
    runAsPlatform(async () => await Branch.countDocuments({ tenantId: t._id })),
    Invoice.find({ tenantId: t._id }).sort({ paidAt: -1 }).limit(50).lean(),
    Payment.find({ tenantId: t._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const { paymentMethod, ...rest } = t.toObject();
  ok(res, { ...rest, paymentMethod: { brand: paymentMethod?.brand, last4: paymentMethod?.last4 }, counts: { users, branches }, invoices, payments });
}));

/** Runs a tenant change, saves it and writes the platform audit entry. */
const change = (action, role, fn, { reason = false } = {}) =>
  router.post(`/tenants/:id/${action}`, needs(...role), wrap(async (req, res) => {
    const t = await loadTenant(req.params.id);
    const why = str(req.body?.reason);
    if (reason && !why) throw badRequest('A reason is required');
    const before = { status: t.status, planCode: t.planCode, trialEndsAt: t.trialEndsAt, freeUntil: t.subscription.freeUntil, branchLimitOverride: t.branchLimitOverride, smsCredits: t.smsCredits };
    const out = await fn(t, req.body || {}, req);
    await t.save();
    await platformAudit({ ...ctx(req), action: `tenant.${action}`, entity: 'Tenant', entityId: t._id, tenantId: t._id, reason: why, before, after: { status: t.status, planCode: t.planCode, trialEndsAt: t.trialEndsAt, freeUntil: t.subscription.freeUntil, branchLimitOverride: t.branchLimitOverride, smsCredits: t.smsCredits } });
    ok(res, out ?? { status: t.status });
  }));

const days = (b) => { const n = Number(b.days); if (!Number.isInteger(n) || n < 1 || n > 365) throw badRequest('Days must be a whole number from 1 to 365'); return n; };

change('suspend', ['support', 'finance'], (t) => { t.status = 'suspended'; }, { reason: true });
change('reactivate', ['support', 'finance'], (t) => {
  if (!['suspended', 'past_due', 'expired', 'cancelled'].includes(t.status)) throw conflict('This shop is not suspended', 'NOT_SUSPENDED');
  t.status = t.planCode && t.subscription.currentPeriodEnd ? 'active' : 'trial';
  t.subscription.pastDueSince = null; t.subscription.retriesDone = 0;
}, { reason: true });
change('extend-trial', ['support', 'sales'], (t, b) => {
  if (!['trial', 'expired'].includes(t.status)) throw conflict('Only shops on a trial can be extended', 'NOT_TRIAL');
  t.trialEndsAt = new Date(Math.max(Date.now(), t.trialEndsAt?.getTime() || 0) + days(b) * DAY);
  t.status = 'trial';
}, { reason: true });
change('free-period', ['finance'], (t, b) => { t.subscription.freeUntil = new Date(Math.max(Date.now(), t.subscription.freeUntil?.getTime() || 0) + days(b) * DAY); }, { reason: true });
change('branch-limit', ['support', 'sales'], (t, b) => {
  const n = b.limit === null ? null : Number(b.limit);
  if (n !== null && (!Number.isInteger(n) || n < 0 || n > 1000)) throw badRequest('Limit must be a whole number (or null to remove the override)');
  t.branchLimitOverride = n;
}, { reason: true });
change('sms-credits', ['support', 'finance'], (t, b) => {
  const n = Number(b.delta);
  if (!Number.isInteger(n) || n === 0 || t.smsCredits + n < 0) throw badRequest('Enter a whole number that does not take the balance below zero');
  t.smsCredits += n;
}, { reason: true });
change('notes', ['support', 'sales', 'finance'], (t, b, req) => {
  const text = str(b.text);
  if (!text || text.length > 1000) throw badRequest('Write a note of up to 1000 characters');
  t.notes.push({ text, by: req.admin.email });
});

// Offline (bank transfer) payment: activates the plan (ADM-13). Creates its own invoice, so not via change().
router.post('/tenants/:id/offline-payment', needs('finance'), wrap(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const b = req.body || {};
  const invoice = await billing.recordOfflinePayment(t, { planCode: str(b.planCode), term: str(b.term), currency: str(b.currency)?.toUpperCase(), amount: b.amount, reference: str(b.reference) }, req.admin);
  ok(res, { invoiceId: invoice._id, number: invoice.number });
}));

// ---- plans (A-05) ----------------------------------------------------------------------------
router.get('/plans', wrap(async (req, res) => ok(res, await listPlans())));
router.put('/plans/:code', needs('finance'), wrap(async (req, res) => {
  await ensurePlans();
  const plan = await Plan.findOne({ code: str(req.params.code)?.toLowerCase() });
  if (!plan) throw notFound('Plan not found');
  const before = plan.toObject();
  plan.set(pick(req.body, ['name', 'prices', 'branchLimit', 'userLimit', 'features', 'trialDays', 'visible']));
  await plan.save(); // prices apply to NEW purchases and renewals only: invoices already issued keep their amounts
  await platformAudit({ ...ctx(req), action: 'plan.update', entity: 'Plan', entityId: plan._id, before, after: plan.toObject() });
  ok(res, plan);
}));

// ---- payments (A-06) -------------------------------------------------------------------------
router.get('/invoices', needs('finance', 'support'), wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = {};
  if (str(req.query.tenantId)) q.tenantId = requireId(str(req.query.tenantId), 'shop id');
  if (str(req.query.status)) q.status = str(req.query.status);
  const [data, total] = await Promise.all([Invoice.find(q).sort({ paidAt: -1 }).skip(skip).limit(limit).lean(), Invoice.countDocuments(q)]);
  ok(res, data, { page, total });
}));
router.get('/payments', needs('finance', 'support'), wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.status) ? { status: str(req.query.status) } : {};
  const [data, total] = await Promise.all([Payment.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Payment.countDocuments(q)]);
  ok(res, data, { page, total });
}));
router.post('/invoices/:id/refund', needs('finance'), wrap(async (req, res) => {
  requireId(req.params.id, 'invoice id');
  const inv = await Invoice.findById(req.params.id);
  if (!inv) throw notFound('Invoice not found');
  const reason = str(req.body?.reason);
  if (!reason) throw badRequest('A reason is required');
  const amount = req.body?.amount === undefined ? undefined : Math.round(Number(req.body.amount) * 100);
  ok(res, await billing.refundInvoice(inv, amount, reason, req.admin));
}));
router.post('/billing/run', needs('finance'), wrap(async (req, res) => {
  const sum = await billing.runBillingCycle();
  await platformAudit({ ...ctx(req), action: 'billing.manual_run', after: sum });
  ok(res, sum);
}));

// ---- simple collections (A-04, A-07 to A-16) -------------------------------------------------
/**
 * list / create / update / delete for a platform collection. `fields` is the whitelist; the request body is
 * never spread into the model. `roles` may read and write (super_admin always can).
 */
function crud(path, Model, { roles, fields, sort = { createdAt: -1 }, filters = [], noDelete = false, search = [] }) {
  const guard = needs(...roles);
  router.get(`/${path}`, guard, wrap(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query);
    const q = {};
    for (const f of filters) if (str(req.query[f])) q[f] = str(req.query[f]);
    const text = str(req.query.q);
    if (text && search.length) { const re = new RegExp(escapeRegex(text), 'i'); q.$or = search.map((k) => ({ [k]: re })); }
    const [data, total] = await Promise.all([Model.find(q).sort(sort).skip(skip).limit(limit).lean(), Model.countDocuments(q)]);
    ok(res, data, { page, total });
  }));
  router.post(`/${path}`, guard, wrap(async (req, res) => {
    const doc = await Model.create(pick(req.body, fields));
    await platformAudit({ ...ctx(req), action: `${path}.create`, entity: Model.modelName, entityId: doc._id, after: doc.toObject() });
    res.status(201).json({ success: true, data: doc });
  }));
  router.put(`/${path}/:id`, guard, wrap(async (req, res) => {
    requireId(req.params.id);
    const doc = await Model.findById(req.params.id);
    if (!doc) throw notFound('Not found');
    const before = doc.toObject();
    doc.set(pick(req.body, fields));
    await doc.save();
    await platformAudit({ ...ctx(req), action: `${path}.update`, entity: Model.modelName, entityId: doc._id, before, after: doc.toObject() });
    ok(res, doc);
  }));
  if (!noDelete) router.delete(`/${path}/:id`, guard, wrap(async (req, res) => {
    requireId(req.params.id);
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw notFound('Not found');
    await platformAudit({ ...ctx(req), action: `${path}.delete`, entity: Model.modelName, entityId: doc._id, before: doc.toObject() });
    ok(res, null);
  }));
}

crud('coupons', Coupon, { roles: ['finance', 'sales'], fields: ['code', 'type', 'percent', 'fixed', 'validFrom', 'validTo', 'maxUses', 'perTenantLimit', 'plans', 'terms', 'active'], noDelete: true }); // deactivate, never delete: invoices reference the code
crud('leads', Lead, { roles: ['sales', 'support'], fields: ['status', 'assignee', 'followUpAt', 'notes'], filters: ['status', 'kind'], search: ['name', 'email', 'shopName'], noDelete: true });
crud('affiliates', Affiliate, { roles: ['sales', 'finance'], fields: ['code', 'name', 'email', 'status', 'commissionPercent'], filters: ['status'], noDelete: true });
crud('payouts', Payout, { roles: ['finance'], fields: ['affiliateId', 'amount', 'currency', 'note', 'paidAt'], filters: ['affiliateId'], noDelete: true });
crud('tickets', SupportTicket, { roles: ['support'], fields: ['status', 'priority', 'assignee'], filters: ['status', 'priority', 'tenantId'], search: ['subject'], noDelete: true });
crud('announcements', Announcement, { roles: ['content', 'support'], fields: ['title', 'body', 'startsAt', 'endsAt', 'plans', 'countries'] });
crud('email-templates', EmailTemplate, { roles: ['content'], fields: ['key', 'subject', 'body'], noDelete: true });
crud('cms', CmsEntry, { roles: ['content'], fields: ['type', 'slug', 'title', 'body', 'data', 'status', 'publishAt'], filters: ['type', 'status'], search: ['title', 'slug'] });
crud('phone-models', PhoneModel, { roles: ['content', 'support'], fields: ['brand', 'name', 'variants'], filters: ['brand'], search: ['name', 'brand'], sort: { brand: 1, name: 1 } });
crud('sms-packages', SmsPackage, { roles: ['finance'], fields: ['name', 'credits', 'price', 'active'], noDelete: true });
crud('flags', FeatureFlag, { roles: [], fields: ['key', 'description', 'enabled', 'tenantIds'] }); // super_admin only
crud('maintenance', Maintenance, { roles: ['support', 'content'], fields: ['title', 'startsAt', 'endsAt', 'notice'] });

// Ticket notes (A-12): internal notes only the admins see
router.post('/tickets/:id/notes', needs('support'), wrap(async (req, res) => {
  requireId(req.params.id);
  const text = str(req.body?.text);
  if (!text || text.length > 2000) throw badRequest('Write a note of up to 2000 characters');
  const t = await SupportTicket.findByIdAndUpdate(req.params.id, { $push: { notes: { text, by: req.admin.email } } }, { new: true });
  if (!t) throw notFound('Ticket not found');
  ok(res, t);
}));

// Lead conversion (A-09): link a lead to the shop it became
router.post('/leads/:id/convert', needs('sales'), wrap(async (req, res) => {
  requireId(req.params.id);
  const tenantId = requireId(str(req.body?.tenantId), 'shop id');
  if (!(await Tenant.exists({ _id: tenantId }))) throw notFound('Shop not found');
  const lead = await Lead.findByIdAndUpdate(req.params.id, { status: 'converted', tenantId }, { new: true });
  if (!lead) throw notFound('Lead not found');
  await platformAudit({ ...ctx(req), action: 'leads.convert', entity: 'Lead', entityId: lead._id, tenantId });
  ok(res, lead);
}));

// ---- audit log (ADM-27) and admin users (ADM-26) ---------------------------------------------
router.get('/audit', needs('finance'), wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = {};
  if (str(req.query.action)) q.action = str(req.query.action);
  if (str(req.query.tenantId)) q.tenantId = requireId(str(req.query.tenantId), 'shop id');
  const [data, total] = await Promise.all([AdminAudit.find(q).sort({ at: -1 }).skip(skip).limit(limit).lean(), AdminAudit.countDocuments(q)]);
  ok(res, data, { page, total });
}));

router.get('/admins', needs(), wrap(async (req, res) => ok(res, await AdminUser.find().sort({ createdAt: 1 }).lean())));
router.post('/admins', needs(), wrap(async (req, res) => {
  const b = req.body || {};
  if (!ADMIN_ROLES.includes(b.role)) throw badRequest('Unknown admin role');
  const pwErr = passwordError(str(b.password) || '');
  if (pwErr) throw badRequest(pwErr);
  const a = await AdminUser.create({ name: str(b.name), email: str(b.email), role: b.role, passwordHash: await hashPassword(b.password), ipAllowList: Array.isArray(b.ipAllowList) ? b.ipAllowList.filter((x) => typeof x === 'string') : [] });
  await platformAudit({ ...ctx(req), action: 'admins.create', entity: 'AdminUser', entityId: a._id, after: { email: a.email, role: a.role } });
  res.status(201).json({ success: true, data: publicAdmin(a) });
}));
router.put('/admins/:id', needs(), wrap(async (req, res) => {
  requireId(req.params.id);
  const a = await AdminUser.findById(req.params.id);
  if (!a) throw notFound('Admin not found');
  const b = req.body || {};
  if (b.role !== undefined && !ADMIN_ROLES.includes(b.role)) throw badRequest('Unknown admin role');
  if (String(a._id) === String(req.admin._id) && (b.isActive === false || (b.role && b.role !== a.role))) throw conflict('You cannot deactivate or demote yourself', 'SELF_CHANGE');
  const before = { role: a.role, isActive: a.isActive };
  a.set(pick(b, ['name', 'role', 'isActive', 'ipAllowList']));
  await a.save();
  if (!a.isActive) await AdminSession.updateMany({ adminId: a._id, revokedAt: null }, { revokedAt: new Date() });
  await platformAudit({ ...ctx(req), action: 'admins.update', entity: 'AdminUser', entityId: a._id, before, after: { role: a.role, isActive: a.isActive } });
  ok(res, publicAdmin(a));
}));

export default router;
