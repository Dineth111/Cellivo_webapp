import Plan, { FEATURES } from './Plan.model.js';
import { notFound } from '../../core/errors.js';

const LKR_PER_USD = 300; // FRS figure 7.21: Growth is $40 / LKR 12,000
const STARTER_UP = FEATURES.filter((f) => f !== 'woocommerce');

const row = (usd) => ({ USD: usd, LKR: usd * LKR_PER_USD });
// yearly = two months free; lifetime ~ 24.75 months (Growth: $990, FRS figure 7.21)
const prices = (m) => ({ monthly: row(m), yearly: row(m * 10), lifetime: row(Math.round((m * 24.75) / 10) * 10) });

// SRS 2.3. Defaults only: the admin dashboard (A-05) edits the stored copies.
export const DEFAULT_PLANS = [
  { code: 'lite', name: 'Lite', rank: 1, prices: prices(10), branchLimit: 1, roleKeys: ['owner', 'cashier'], features: ['pos'] },
  { code: 'starter', name: 'Starter', rank: 2, prices: prices(25), branchLimit: 1, features: STARTER_UP },
  { code: 'growth', name: 'Growth', rank: 3, prices: prices(40), branchLimit: 3, features: FEATURES },
  { code: 'business', name: 'Business', rank: 4, prices: prices(55), branchLimit: 6, features: FEATURES },
  { code: 'unlimited', name: 'Unlimited', rank: 5, prices: prices(0), branchLimit: null, features: FEATURES, visible: false, contactSales: true },
];

let seeded = false;
/** Insert the default plans once (never overwrites edits). */
export async function ensurePlans() {
  if (seeded) return;
  await Plan.bulkWrite(DEFAULT_PLANS.map((p) => ({ updateOne: { filter: { code: p.code }, update: { $setOnInsert: p }, upsert: true } })));
  seeded = true;
}
export const resetPlanCache = () => { seeded = false; }; // tests drop the database

export async function listPlans({ visibleOnly = false } = {}) {
  await ensurePlans();
  return Plan.find(visibleOnly ? { visible: true } : {}).sort({ rank: 1 }).lean();
}

export async function getPlan(code) {
  await ensurePlans();
  const plan = code && (await Plan.findOne({ code: String(code).toLowerCase() }).lean());
  if (!plan) throw notFound('Plan not found');
  return plan;
}

/** Price of one billing period in the given currency, or null for contact-sales plans. */
export function planPrice(plan, term, currency) {
  if (plan.contactSales) return null;
  return plan.prices?.[term]?.[currency] ?? null;
}

/** Cost per month, used to tell an upgrade from a downgrade. Lifetime is the top of the scale. */
export function monthlyEquivalent(plan, term) {
  const p = plan.prices?.[term]?.USD ?? 0;
  return term === 'monthly' ? p : term === 'yearly' ? p / 12 : Infinity;
}

/** Lowest plan that includes a feature (used in the "upgrade to use it" message). */
export async function cheapestPlanWith(feature) {
  const plans = await listPlans();
  return plans.find((p) => p.features.includes(feature)) ?? null;
}
