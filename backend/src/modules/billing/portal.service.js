import Branch from '../branches/Branch.model.js';
import { Invoice, Notice } from './billing.models.js';
import { getPlan, planPrice } from '../plans/plans.service.js';
import { branchLimit, DEFAULT_PLAN } from '../plans/planLimits.js';
import { RETRY_DAYS, READ_ONLY_DAYS } from './billing.service.js';

/** FRS 7.2 "Page states". new | trial | active | past_due | suspended (also cancelled, expired, archived). */
export function portalState(t) {
  if (t.status === 'trial') return t.planCode ? 'trial' : 'new';
  if (t.status === 'active') return 'active';
  if (t.status === 'past_due') return 'past_due';
  return 'suspended';
}

const SETUP = {
  new: { percent: 0, label: 'Choose a plan', tone: 'neutral' },
  trial: { percent: 66, label: 'Add payment', tone: 'neutral' },
  active: { percent: 100, label: 'Complete', tone: 'neutral' },
  past_due: { percent: 100, label: 'Payment needed', tone: 'warning' },
  suspended: { percent: 100, label: 'Action needed', tone: 'danger' },
};

/**
 * Everything the portal home needs (ACC-11 to ACC-18), from real billing data.
 * `tenant` is the Tenant document; call inside the tenant context (counts branches).
 */
export async function portalSummary(tenant, user, now = new Date()) {
  const state = portalState(tenant);
  const plan = await getPlan(tenant.planCode ?? DEFAULT_PLAN);
  const s = tenant.subscription;
  const [branchesUsed, invoices, notices] = await Promise.all([
    Branch.countDocuments({ isActive: true }),
    Invoice.find({ tenantId: tenant._id, status: { $ne: 'void' } }).sort({ paidAt: -1 }).lean(),
    Notice.find({ tenantId: tenant._id, readAt: null }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);

  // lifetime spend = paid invoices net of refunds, in the account currency (FRS 7.2 business rules)
  const spend = invoices
    .filter((i) => i.currency === tenant.billingCurrency)
    .reduce((sum, i) => sum + i.total - i.refunds.reduce((r, x) => r + x.amount, 0), 0);

  const price = planPrice(plan, tenant.billingTerm, tenant.billingCurrency);
  const trialDaysLeft = tenant.trialEndsAt ? Math.max(0, Math.ceil((tenant.trialEndsAt - now) / 864e5)) : null;
  const limit = branchLimit(plan, tenant);

  return {
    state,
    status: tenant.status,
    ownerName: user.name,
    shopName: tenant.name,
    plan: { code: plan.code, name: plan.name, chosen: !!tenant.planCode, price, term: tenant.billingTerm, currency: tenant.billingCurrency },
    renewsAt: tenant.billingTerm === 'lifetime' ? null : s.currentPeriodEnd,
    nextRetry: tenant.status === 'past_due' ? RETRY_DAYS[s.retriesDone] !== undefined ? new Date(s.pastDueSince.getTime() + RETRY_DAYS[s.retriesDone] * 864e5) : null : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    pendingPlanCode: s.pendingPlanCode,
    readOnlyDays: READ_ONLY_DAYS,
    trialDaysLeft,
    trialEndsAt: tenant.trialEndsAt,
    setup: SETUP[state],
    branches: { used: branchesUsed, limit },
    paymentMethod: tenant.paymentMethod?.last4 ? { brand: tenant.paymentMethod.brand, last4: tenant.paymentMethod.last4 } : null,
    stats: {
      lifetimeSpend: spend, // minor units
      currentBilling: tenant.status,
      activePlans: ['trial', 'active', 'past_due'].includes(tenant.status) ? 1 : 0,
      memberSince: tenant.createdAt,
      invoiceCount: invoices.length,
      lastPaidAt: invoices[0]?.paidAt ?? null,
    },
    affiliate: { visible: !tenant.affiliateBannerHiddenUntil || tenant.affiliateBannerHiddenUntil < now, code: tenant.affiliateCode },
    notices: notices.map((n) => ({ id: n._id, kind: n.kind, message: n.message, at: n.createdAt })),
  };
}
