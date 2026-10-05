import Tenant from '../tenants/Tenant.model.js';
import Branch from '../branches/Branch.model.js';
import { Invoice, Payment, Notice, nextNumber } from './billing.models.js';
import { gateway } from './gateway.js';
import { applyCoupon, redeemCoupon } from './coupons.service.js';
import { getPlan, planPrice, monthlyEquivalent } from '../plans/plans.service.js';
import { branchLimit } from '../plans/planLimits.js';
import { platformAudit } from '../admin/admin.models.js';
import { runWithContext } from '../../core/tenantContext.js';
import { config } from '../../core/config.js';
import { badRequest, conflict, AppError } from '../../core/errors.js';
import audit from '../../core/audit.js';

/**
 * Subscription billing (FRS F-02, ACC-05 to ACC-10). All money is integer minor units (cents).
 *
 *  - upgrade: immediate, prorated credit for the unused part of the paid period
 *  - downgrade: scheduled for the next renewal (blocked while branches exceed the new limit)
 *  - failed renewal: retried on days 1, 3 and 5, then Suspended after SUSPEND_AFTER_DAYS (7)
 *  - cancel: full access until the paid period ends, then read-only 30 days, then archived
 */
export const DAY = 864e5;
export const RETRY_DAYS = [1, 3, 5];
export const READ_ONLY_DAYS = 30;
const PAID_STATES = ['active', 'past_due'];

const minor = (major) => Math.round(major * 100);

export function addTerm(date, term) {
  if (term === 'lifetime') return null;
  const d = new Date(date);
  if (term === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/** The shop currently has a paid plan running (active, or past due but not yet suspended). */
const hasPaidPlan = (t, now) =>
  PAID_STATES.includes(t.status) && !!t.planCode && (t.billingTerm === 'lifetime' || (t.subscription.currentPeriodEnd && t.subscription.currentPeriodEnd > now) || t.status === 'past_due');

const taxOn = (amount) => Math.round((amount * config.subscriptionTaxPercent) / 100);

async function notice(tenantId, kind, message) {
  await Notice.create({ tenantId, kind, message });
  // TODO(Dev 5): also email the owner through the notification service (FRS appendix A: trial ending / payment failed / suspended)
  if (config.env !== 'production') console.log(`[dev] notice to tenant ${tenantId}: ${message}`);
}

/**
 * What a purchase would cost and when it takes effect. Needs tenant context (counts branches).
 * kind: new (first/returning purchase), upgrade (immediate, prorated), downgrade (at renewal), renewal (pay current plan again)
 */
export async function quote(tenant, { planCode, term, currency, couponCode }, now = new Date()) {
  const plan = await getPlan(planCode);
  if (plan.contactSales) throw badRequest('The Unlimited plan is arranged with our sales team. Please contact sales.', 'CONTACT_SALES');
  if (!['monthly', 'yearly', 'lifetime'].includes(term)) throw badRequest('Choose monthly, yearly or lifetime billing');
  const paid = hasPaidPlan(tenant, now);
  currency = paid && tenant.status === 'active' ? tenant.billingCurrency : currency || tenant.billingCurrency;
  if (!['USD', 'LKR'].includes(currency)) throw badRequest('Currency must be USD or LKR');
  const price = planPrice(plan, term, currency);
  if (price === null) throw badRequest('This plan has no price for the selected term');
  const priceMinor = minor(price);

  // ACC-06: never put a shop on a plan that has fewer branches than it already uses
  const limit = branchLimit(plan, tenant);
  if (limit !== null) {
    const active = await Branch.countDocuments({ isActive: true });
    if (active > limit) throw conflict(`You have ${active} active branches but ${plan.name} allows ${limit}. Archive ${active - limit} branch${active - limit === 1 ? '' : 'es'} first.`, 'BRANCH_LIMIT');
  }

  let kind = 'new';
  let credit = 0;
  if (paid && tenant.status === 'active') {
    const current = await getPlan(tenant.planCode);
    if (tenant.planCode === planCode && tenant.billingTerm === term) throw conflict('You are already on this plan and billing term.', 'SAME_PLAN');
    if (tenant.billingTerm === 'lifetime') {
      if (monthlyEquivalent(plan, term) !== Infinity && plan.rank <= current.rank) throw conflict('Lifetime plans cannot be downgraded. Contact support.', 'LIFETIME');
    }
    const up = monthlyEquivalent(plan, term) > monthlyEquivalent(current, tenant.billingTerm);
    kind = up ? 'upgrade' : 'downgrade';
    const s = tenant.subscription;
    if (up && s.currentPeriodEnd && s.currentPeriodStart && s.currentPeriodEnd > now) {
      const total = s.currentPeriodEnd - s.currentPeriodStart;
      const left = s.currentPeriodEnd - now;
      const paidMinor = minor(planPrice(current, tenant.billingTerm, tenant.billingCurrency) ?? 0);
      credit = Math.min(paidMinor, Math.round((paidMinor * left) / total));
    }
  } else if (tenant.status === 'past_due' && tenant.planCode === planCode && tenant.billingTerm === term) {
    kind = 'renewal';
  }

  let discount = 0;
  let coupon = null;
  if (couponCode && kind !== 'downgrade') ({ coupon, discount } = await applyCoupon(couponCode, { planCode, term, currency, priceMinor, tenantId: tenant._id }, now));

  const taxable = Math.max(0, priceMinor - discount - credit);
  const tax = taxOn(taxable);
  return {
    kind, planCode, planName: plan.name, term, currency,
    price: priceMinor, discount, credit, tax, total: kind === 'downgrade' ? 0 : taxable + tax,
    couponCode: coupon?.code ?? null, coupon,
    effectiveAt: kind === 'downgrade' ? tenant.subscription.currentPeriodEnd : now,
  };
}

export const publicQuote = ({ coupon, ...q }) => q;

async function recordPayment(tenant, { amount, currency, result, attempt = 1, invoiceId, method = 'card' }) {
  return Payment.create({
    tenantId: tenant._id, invoiceId, amount, currency, status: result.ok ? 'paid' : 'failed', method,
    gateway: gateway().name, gatewayRef: result.ref || '', error: result.error || '', attempt,
  });
}

async function createInvoice(tenant, q, { kind = q.kind, periodStart, periodEnd, method = 'card', reference = '', now = new Date() }) {
  const number = `SUB-${await nextNumber('invoice')}`;
  return Invoice.create({
    number, tenantId: tenant._id, kind, planCode: q.planCode, term: q.term, currency: q.currency,
    price: q.price, discount: q.discount, credit: q.credit, tax: q.tax, total: q.total, couponCode: q.couponCode,
    status: 'paid', method, reference, periodStart, periodEnd: periodEnd ?? undefined, paidAt: now,
    billTo: { name: tenant.billingDetails?.name || tenant.name, address: tenant.billingDetails?.address || '', taxNumber: tenant.billingDetails?.taxNumber || '' },
  });
}

/** Make the plan active from `now` after a successful payment. */
function activate(tenant, q, now, start = now) {
  const s = tenant.subscription;
  tenant.planCode = q.planCode;
  tenant.billingTerm = q.term;
  tenant.billingCurrency = q.currency;
  tenant.currency = q.currency;
  tenant.status = 'active';
  s.currentPeriodStart = start;
  s.currentPeriodEnd = addTerm(start, q.term);
  s.pendingPlanCode = null;
  s.pendingBillingTerm = null;
  s.cancelAtPeriodEnd = false;
  s.cancelledAt = null;
  s.pastDueSince = null;
  s.retriesDone = 0;
  if (q.couponCode) tenant.couponCode = q.couponCode;
}

/** Store the card the owner just entered with the gateway; the raw number is never kept. */
export async function setPaymentMethod(tenant, { number }) {
  const t = await gateway().tokenize({ number });
  if (t.error) throw badRequest(t.error, 'CARD_INVALID');
  tenant.paymentMethod = { brand: t.brand, last4: t.last4, token: t.token };
  return tenant;
}

/**
 * Buy, upgrade or downgrade. `tenant` is a full Tenant document (select +paymentMethod.token).
 * Downgrades only schedule the change. Returns { quote, invoice?, scheduled? }.
 */
export async function subscribe(tenant, body, now = new Date()) {
  const q = await quote(tenant, body, now);
  if (q.kind === 'downgrade') {
    tenant.subscription.pendingPlanCode = q.planCode;
    tenant.subscription.pendingBillingTerm = q.term;
    await tenant.save();
    await audit.record({ action: 'billing.downgrade_scheduled', entity: 'Tenant', entityId: tenant._id, after: { planCode: q.planCode, term: q.term } });
    return { quote: publicQuote(q), scheduled: true };
  }
  if (body.card?.number) await setPaymentMethod(tenant, body.card);
  const result = await gateway().charge({ token: tenant.paymentMethod?.token, amount: q.total, currency: q.currency, ref: `${tenant._id}-${now.getTime()}` });
  if (!result.ok) {
    await recordPayment(tenant, { amount: q.total, currency: q.currency, result });
    throw new AppError(402, `Payment failed: ${result.error}. Check your card and try again.`, 'PAYMENT_FAILED');
  }
  const before = { planCode: tenant.planCode, term: tenant.billingTerm, status: tenant.status };
  const start = now;
  const invoice = await createInvoice(tenant, q, { periodStart: start, periodEnd: addTerm(start, q.term), reference: result.ref, now });
  await recordPayment(tenant, { amount: q.total, currency: q.currency, result, invoiceId: invoice._id });
  activate(tenant, q, now, start);
  await tenant.save();
  if (q.coupon) await redeemCoupon(q.coupon);
  await audit.record({ action: `billing.${q.kind}`, entity: 'Tenant', entityId: tenant._id, before, after: { planCode: q.planCode, term: q.term, invoice: invoice.number } });
  return { quote: publicQuote(q), invoice };
}

/** Cancel at any time: full access until the paid period ends (ACC-07). Trials end immediately. */
export async function cancel(tenant, now = new Date()) {
  const s = tenant.subscription;
  if (['cancelled', 'archived', 'expired', 'suspended'].includes(tenant.status)) throw conflict('This subscription is not active.', 'NOT_ACTIVE');
  if (tenant.status === 'trial' || tenant.billingTerm === 'lifetime' || !s.currentPeriodEnd) {
    tenant.status = 'cancelled';
    s.cancelledAt = now;
  } else {
    s.cancelAtPeriodEnd = true;
  }
  s.pendingPlanCode = null;
  s.pendingBillingTerm = null;
  await tenant.save();
  await audit.record({ action: 'billing.cancel', entity: 'Tenant', entityId: tenant._id, after: { status: tenant.status, cancelAtPeriodEnd: s.cancelAtPeriodEnd } });
  return tenant;
}

export async function undoCancel(tenant) {
  if (!tenant.subscription.cancelAtPeriodEnd) throw conflict('Nothing to undo.', 'NOT_CANCELLING');
  tenant.subscription.cancelAtPeriodEnd = false;
  await tenant.save();
  await audit.record({ action: 'billing.cancel_undone', entity: 'Tenant', entityId: tenant._id });
}

/** Admin (A-03 / ADM-13): activate a plan after an offline bank transfer, no gateway involved. */
export async function recordOfflinePayment(tenant, { planCode, term, currency, amount, reference }, admin, now = new Date()) {
  const plan = await getPlan(planCode);
  const price = planPrice(plan, term, currency);
  if (price === null) throw badRequest('This plan has no price for the selected term');
  const total = amount !== undefined ? minor(Number(amount)) : minor(price);
  if (!(total >= 0)) throw badRequest('Amount must be zero or more');
  const q = { kind: 'offline', planCode, term, currency, price: minor(price), discount: 0, credit: 0, tax: 0, total, couponCode: null };
  const invoice = await createInvoice(tenant, q, { periodStart: now, periodEnd: addTerm(now, term), method: 'bank_transfer', reference, now });
  await Payment.create({ tenantId: tenant._id, invoiceId: invoice._id, amount: total, currency, status: 'paid', method: 'bank_transfer', gateway: 'offline', gatewayRef: reference || '' });
  activate(tenant, q, now);
  await tenant.save();
  await platformAudit({ admin, action: 'payment.offline', entity: 'Invoice', entityId: invoice._id, tenantId: tenant._id, after: { number: invoice.number, total } });
  return invoice;
}

/** Admin: refund part or all of an invoice (A-06). */
export async function refundInvoice(invoice, amountMinor, reason, admin) {
  const refunded = invoice.refunds.reduce((s, r) => s + r.amount, 0);
  const amount = amountMinor ?? invoice.total - refunded;
  if (!(amount > 0) || refunded + amount > invoice.total) throw badRequest('Refund amount must be more than 0 and not more than what was paid');
  if (invoice.method === 'card') {
    const r = await gateway().refund({ ref: invoice.reference, amount });
    if (!r.ok) throw new AppError(502, 'The payment gateway refused the refund', 'REFUND_FAILED');
  }
  invoice.refunds.push({ amount, reason, by: admin.email });
  invoice.status = refunded + amount === invoice.total ? 'refunded' : 'partially_refunded';
  await invoice.save();
  await platformAudit({ admin, action: 'payment.refund', entity: 'Invoice', entityId: invoice._id, tenantId: invoice.tenantId, reason, after: { amount } });
  return invoice;
}

// ---------------------------------------------------------------------------------------------
// The renewal job. Run it on a timer (server.js) and from the admin dashboard.
// ---------------------------------------------------------------------------------------------

async function chargeRenewal(tenant, now, attempt) {
  const plan = await getPlan(tenant.planCode);
  const price = planPrice(plan, tenant.billingTerm, tenant.billingCurrency);
  const base = minor(price ?? 0);
  const q = { kind: 'renewal', planCode: plan.code, term: tenant.billingTerm, currency: tenant.billingCurrency, price: base, discount: 0, credit: 0, tax: taxOn(base), couponCode: null };
  q.total = base + q.tax;
  const result = await gateway().charge({ token: tenant.paymentMethod?.token, amount: q.total, currency: q.currency, renewal: true, ref: `${tenant._id}-renew-${now.getTime()}` });
  if (!result.ok) {
    await recordPayment(tenant, { amount: q.total, currency: q.currency, result, attempt });
    return false;
  }
  const start = tenant.subscription.currentPeriodEnd ?? now;
  const invoice = await createInvoice(tenant, q, { periodStart: start, periodEnd: addTerm(start, tenant.billingTerm), reference: result.ref, now });
  await recordPayment(tenant, { amount: q.total, currency: q.currency, result, attempt, invoiceId: invoice._id });
  activate(tenant, q, now, start);
  return true;
}

async function applyPendingChange(tenant) {
  const s = tenant.subscription;
  if (!s.pendingPlanCode) return;
  const plan = await getPlan(s.pendingPlanCode);
  const active = await runWithContext({ tenantId: tenant._id }, async () => await Branch.countDocuments({ isActive: true })); // await inside: a bare query would run after the context ends
  const limit = branchLimit(plan, tenant);
  if (limit !== null && active > limit) {
    await notice(tenant._id, 'downgrade_blocked', `Your downgrade to ${plan.name} was not applied: you still have ${active} active branches (limit ${limit}).`);
  } else {
    tenant.planCode = plan.code;
    tenant.billingTerm = s.pendingBillingTerm || tenant.billingTerm;
  }
  s.pendingPlanCode = null;
  s.pendingBillingTerm = null;
}

async function processTenant(t, now, sum) {
  const s = t.subscription;
  const sys = (action, extra = {}) => platformAudit({ action, entity: 'Tenant', entityId: t._id, tenantId: t._id, ...extra });

  if (t.status === 'trial') {
    if (t.trialEndsAt && t.trialEndsAt <= now) {
      t.status = 'expired';
      await t.save();
      await notice(t._id, 'trial_expired', 'Your free trial has ended. Choose a plan to keep using Cellivo.');
      await sys('billing.trial_expired');
      sum.expired++;
    }
    return;
  }

  if (t.status === 'active') {
    if (t.billingTerm === 'lifetime' || !s.currentPeriodEnd || s.currentPeriodEnd > now || (s.freeUntil && s.freeUntil > now)) return;
    if (s.cancelAtPeriodEnd) {
      t.status = 'cancelled';
      s.cancelledAt = now;
      await t.save();
      await notice(t._id, 'cancelled', `Your subscription has ended. Your shop is read-only for ${READ_ONLY_DAYS} days, then archived.`);
      await sys('billing.cancelled');
      sum.cancelled++;
      return;
    }
    await applyPendingChange(t);
    if (await chargeRenewal(t, now, 1)) { await t.save(); sum.renewed++; return; }
    t.status = 'past_due';
    s.pastDueSince = now;
    s.retriesDone = 0;
    await t.save();
    await notice(t._id, 'payment_failed', 'Your payment failed. Update your payment method; we will retry on days 1, 3 and 5.');
    await sys('billing.payment_failed');
    sum.failed++;
    return;
  }

  if (t.status === 'past_due') {
    const days = (now - s.pastDueSince) / DAY;
    if (s.retriesDone < RETRY_DAYS.length && days >= RETRY_DAYS[s.retriesDone]) {
      if (await chargeRenewal(t, now, s.retriesDone + 2)) { await t.save(); sum.recovered++; return; }
      s.retriesDone++;
      await notice(t._id, 'payment_failed', `Payment failed again (retry ${s.retriesDone} of ${RETRY_DAYS.length}). Update your payment method.`);
    }
    if (days >= config.suspendAfterDays) {
      t.status = 'suspended';
      await notice(t._id, 'suspended', 'Your shop is suspended because the subscription is unpaid. Pay now to continue.');
      await sys('billing.suspended');
      sum.suspended++;
    }
    await t.save();
    return;
  }

  if (t.status === 'cancelled' && s.cancelledAt && now - s.cancelledAt >= READ_ONLY_DAYS * DAY) {
    t.status = 'archived';
    s.archivedAt = now;
    await t.save();
    await sys('billing.archived'); // data is deleted 90 days after archival unless reactivated (FRS F-02): a retention job, not built yet
    sum.archived++;
  }
}

export async function runBillingCycle(now = new Date()) {
  const sum = { checked: 0, renewed: 0, failed: 0, recovered: 0, suspended: 0, cancelled: 0, expired: 0, archived: 0, errors: 0 };
  const tenants = await Tenant.find({ status: { $in: ['trial', 'active', 'past_due', 'cancelled'] } }).select('+paymentMethod.token');
  for (const t of tenants) {
    sum.checked++;
    try { await processTenant(t, now, sum); } catch (e) { sum.errors++; console.error('[billing]', t._id, e); }
  }
  lastRun = { at: now, ...sum };
  return sum;
}

let lastRun = null;
export const lastBillingRun = () => lastRun;
