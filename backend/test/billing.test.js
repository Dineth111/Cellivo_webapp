import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import { Invoice, Payment, Coupon, Notice } from '../src/modules/billing/billing.models.js';
import { runBillingCycle, DAY } from '../src/modules/billing/billing.service.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const CARD = { number: '4242424242424242' };
const buy = (owner, planCode, term = 'monthly', extra = {}) =>
  api('post', '/api/billing/subscribe', owner.token).send({ planCode, term, currency: 'LKR', card: CARD, ...extra });
const tenantOf = (owner) => Tenant.findById(owner.user.tenant._id).select('+paymentMethod.token');
const addBranch = (owner, n) => api('post', '/api/branches', owner.token).send({ name: `Branch ${n}`, invoicePrefix: `B${n}-` });
const later = (days) => new Date(Date.now() + days * DAY);

describe('F-01 sign-up', () => {
  const form = (o = {}) => ({
    name: 'Nimal Perera', shopName: 'Nimal Mobile', email: 'nimal@shop.lk', phone: '+94771234567', country: 'LK',
    password: 'Passw0rdX', acceptTerms: true, planCode: 'growth', term: 'yearly', ...o,
  });

  it('verifies the code, then provisions the shop on a trial of the chosen plan', async () => {
    const start = await api('post', '/api/signup/start').send(form());
    expect(start.status).toBe(202);
    const done = await api('post', '/api/signup/verify').send({ email: 'nimal@shop.lk', code: start.body.data.devCode });
    expect(done.status).toBe(201);
    const me = await api('get', '/api/billing/summary', done.body.token);
    expect(me.body.data).toMatchObject({ state: 'trial', status: 'trial', plan: { code: 'growth', term: 'yearly' }, setup: { percent: 66 } });
    expect(me.body.data.trialDaysLeft).toBeGreaterThan(12);
    const t = await Tenant.findOne({ ownerEmail: 'nimal@shop.lk' });
    expect(t.timezone).toBe('Asia/Colombo');
  });

  it('rejects a wrong code, an expired sign-up, and a code used twice', async () => {
    const { body } = await api('post', '/api/signup/start').send(form());
    expect((await api('post', '/api/signup/verify').send({ email: 'nimal@shop.lk', code: '000000' })).body.code).toBe('CODE_WRONG');
    expect((await api('post', '/api/signup/verify').send({ email: 'nimal@shop.lk', code: body.data.devCode })).status).toBe(201);
    expect((await api('post', '/api/signup/verify').send({ email: 'nimal@shop.lk', code: body.data.devCode })).status).toBe(400);
  });

  it('validates fields (V-01) and asks for no payment details', async () => {
    for (const bad of [{ name: 'A' }, { phone: '0771234567' }, { password: 'short1' }, { acceptTerms: false }, { country: 'ZZ' }, { email: 'nope' }]) {
      expect((await api('post', '/api/signup/start').send(form(bad))).status).toBe(400);
    }
    expect(JSON.stringify(form())).not.toMatch(/card/i);
  });

  it('one trial per email and per mobile number', async () => {
    const a = await api('post', '/api/signup/start').send(form());
    await api('post', '/api/signup/verify').send({ email: 'nimal@shop.lk', code: a.body.data.devCode });
    const dupEmail = await api('post', '/api/signup/start').send(form());
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.message).toBe('An account with this email already exists. Log in or reset your password.');
    expect((await api('post', '/api/signup/start').send(form({ email: 'other@shop.lk' }))).body.code).toBe('PHONE_TAKEN');
  });

  it('accepts an active coupon or approved affiliate code, rejects unknown ones', async () => {
    await Coupon.create({ code: 'WELCOME20', type: 'percent', percent: 20 });
    expect((await api('post', '/api/signup/start').send(form({ code: 'welcome20' }))).status).toBe(202);
    expect((await api('post', '/api/signup/start').send(form({ email: 'b@shop.lk', phone: '+94770000001', code: 'NOPE' }))).body.code).toBe('CODE_INVALID');
  });
});

describe('plan limits are enforced on the server', () => {
  it('branch limit: Starter allows 1, Growth allows 3 (V-09)', async () => {
    const o = await signup('o@x.lk');
    const blocked = await addBranch(o, 2);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'Your plan allows 1 branch. Upgrade to add more.' });
    expect((await buy(o, 'growth')).status).toBe(201);
    expect((await addBranch(o, 2)).status).toBe(201);
    expect((await addBranch(o, 3)).status).toBe(201);
    expect((await addBranch(o, 4)).status).toBe(403);
  });

  it('Lite: owner and cashier roles only, no custom roles; admin can override the branch limit', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'lite');
    const roles = (await api('get', '/api/roles', o.token)).body.data;
    const branches = (await api('get', '/api/branches', o.token)).body.data;
    const invite = (key) => api('post', '/api/users', o.token).send({ name: 'Staff', email: `${key}@x.lk`, roleId: roles.find((r) => r.key === key)._id, branchIds: [branches[0]._id] });
    expect((await invite('cashier')).status).toBe(201);
    expect((await invite('technician')).status).toBe(403);
    const custom = await api('post', '/api/roles', o.token).send({ name: 'Supervisor' });
    expect(custom.status).toBe(403);
    expect(custom.body.code).toBe('FEATURE_NOT_IN_PLAN');
    await Tenant.updateOne({ _id: o.user.tenant._id }, { branchLimitOverride: 2 });
    expect((await addBranch(o, 2)).status).toBe(201);
  });

  it('a suspended shop is read-only but can still reach billing (V-11)', async () => {
    const o = await signup('o@x.lk');
    await Tenant.updateOne({ _id: o.user.tenant._id }, { status: 'suspended' });
    expect((await api('get', '/api/customers', o.token)).status).toBe(200);
    const w = await api('post', '/api/customers', o.token).send({ name: 'X', phone: '0770000000' });
    expect(w.status).toBe(402);
    expect(w.body.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await api('get', '/api/billing/summary', o.token)).body.data.state).toBe('suspended');
    expect((await api('get', '/api/billing/export', o.token)).status).toBe(200);
    expect((await buy(o, 'starter')).status).toBe(201); // pay -> active again
    expect((await api('post', '/api/customers', o.token).send({ name: 'X', phone: '0770000000' })).status).toBe(201);
  });
});

describe('F-02 subscription and billing', () => {
  it('buys a plan: invoice, payment, active status, PDF download', async () => {
    const o = await signup('o@x.lk');
    const r = await buy(o, 'growth');
    expect(r.status).toBe(201);
    const inv = await Invoice.findOne();
    expect(inv).toMatchObject({ total: 1200000, planCode: 'growth', currency: 'LKR', status: 'paid' }); // LKR 12,000.00 in minor units
    const s = (await api('get', '/api/billing/summary', o.token)).body.data;
    expect(s).toMatchObject({ state: 'active', plan: { code: 'growth', price: 12000 }, paymentMethod: { last4: '4242' }, stats: { lifetimeSpend: 1200000, activePlans: 1 } });
    const pdf = await api('get', `/api/billing/invoices/${inv._id}/pdf`, o.token).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('upgrade is immediate with a prorated credit for the unused time', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'starter'); // LKR 7,500 / month
    const t = await Tenant.findById(o.user.tenant._id);
    const start = new Date(Date.now() - 15 * DAY);
    await Tenant.updateOne({ _id: t._id }, { 'subscription.currentPeriodStart': start, 'subscription.currentPeriodEnd': new Date(start.getTime() + 30 * DAY) });
    const q = await api('post', '/api/billing/quote', o.token).send({ planCode: 'growth', term: 'monthly' });
    expect(q.body.data.kind).toBe('upgrade');
    expect(q.body.data.credit).toBeGreaterThan(370000);
    expect(q.body.data.credit).toBeLessThan(380000); // about half of 750,000
    expect(q.body.data.total).toBe(1200000 - q.body.data.credit);
    expect((await buy(o, 'growth')).status).toBe(201);
    expect((await Tenant.findById(t._id)).planCode).toBe('growth');
  });

  it('downgrade waits for the next renewal and is blocked by too many branches (ACC-06)', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'growth');
    await addBranch(o, 2);
    const blocked = await buy(o, 'starter');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('BRANCH_LIMIT');
    const branches = (await api('get', '/api/branches', o.token)).body.data;
    await api('put', `/api/branches/${branches[1]._id}`, o.token).send({ isActive: false });
    const ok = await buy(o, 'starter');
    expect(ok.body.data).toMatchObject({ scheduled: true });
    expect((await Tenant.findById(o.user.tenant._id)).planCode).toBe('growth'); // still growth until renewal
    await runBillingCycle(later(31));
    const t = await Tenant.findById(o.user.tenant._id);
    expect(t).toMatchObject({ planCode: 'starter', status: 'active' });
  });

  it('a declined card pays nothing and keeps the old state', async () => {
    const o = await signup('o@x.lk');
    const r = await buy(o, 'growth', 'monthly', { card: { number: '4000000000000002' } });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('PAYMENT_FAILED');
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await Payment.countDocuments({ status: 'failed' })).toBe(1);
    expect((await Tenant.findById(o.user.tenant._id)).status).toBe('trial');
  });

  it('coupons: percent off, expiry, per-shop limit', async () => {
    const o = await signup('o@x.lk');
    await Coupon.create({ code: 'HALF', type: 'percent', percent: 50 });
    await Coupon.create({ code: 'OLD', type: 'percent', percent: 50, validTo: new Date(Date.now() - DAY) });
    const q = await api('post', '/api/billing/quote', o.token).send({ planCode: 'growth', term: 'monthly', couponCode: 'half' });
    expect(q.body.data).toMatchObject({ price: 1200000, discount: 600000, total: 600000 });
    expect((await api('post', '/api/billing/quote', o.token).send({ planCode: 'growth', term: 'monthly', couponCode: 'OLD' })).body.code).toBe('COUPON_INVALID');
    await buy(o, 'growth', 'monthly', { couponCode: 'HALF' });
    expect((await Coupon.findOne({ code: 'HALF' })).usedCount).toBe(1);
    await Tenant.updateOne({ _id: o.user.tenant._id }, { status: 'suspended' });
    expect((await api('post', '/api/billing/quote', o.token).send({ planCode: 'growth', term: 'yearly', couponCode: 'HALF' })).body.code).toBe('COUPON_INVALID');
  });

  it('cancel keeps access to the period end, then read-only, then archived (ACC-07)', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'growth');
    expect((await api('post', '/api/billing/cancel', o.token)).status).toBe(200);
    expect((await Tenant.findById(o.user.tenant._id)).status).toBe('active');
    await runBillingCycle(later(31));
    expect((await Tenant.findById(o.user.tenant._id)).status).toBe('cancelled');
    expect((await api('post', '/api/customers', o.token).send({ name: 'X', phone: '0770000000' })).status).toBe(402);
    await runBillingCycle(later(31 + 31));
    expect((await Tenant.findById(o.user.tenant._id)).status).toBe('archived');
  });

  it('only the owner can open billing, and never another shop\'s invoices', async () => {
    const a = await signup('a@x.lk');
    const b = await signup('b@x.lk', 'Other Shop');
    await buy(a, 'growth');
    const inv = await Invoice.findOne();
    const cashier = await addStaff(a, 'cashier', 'c@x.lk');
    expect((await api('get', '/api/billing/summary', cashier.token)).status).toBe(403);
    expect((await api('get', `/api/billing/invoices/${inv._id}/pdf`, b.token)).status).toBe(404);
    expect((await api('get', '/api/billing/invoices', b.token)).body.count).toBe(0);
  });
});

describe('renewals, retries and suspension (ACC-08)', () => {
  it('renews automatically on the renewal date', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'starter');
    const sum = await runBillingCycle(later(31));
    expect(sum.renewed).toBe(1);
    expect(await Invoice.countDocuments()).toBe(2);
  });

  it('failed renewal: past due, retry on days 1, 3, 5, suspended after 7 days, paying reactivates', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'starter', 'monthly', { card: { number: '4000000000009995' } }); // works now, declined on renewal
    const end = (await Tenant.findById(o.user.tenant._id)).subscription.currentPeriodEnd;
    const at = (d) => new Date(end.getTime() + d * DAY + 1000);
    const status = async () => (await Tenant.findById(o.user.tenant._id)).status;

    expect((await runBillingCycle(at(0))).failed).toBe(1);
    expect(await status()).toBe('past_due');
    expect((await api('get', '/api/billing/summary', o.token)).body.data.state).toBe('past_due');
    expect(await Notice.countDocuments({ kind: 'payment_failed' })).toBe(1);

    await runBillingCycle(at(0.5));
    expect(await Payment.countDocuments({ status: 'failed' })).toBe(1); // too early for the day-1 retry
    await runBillingCycle(at(1));
    await runBillingCycle(at(3));
    await runBillingCycle(at(5));
    expect(await Payment.countDocuments({ status: 'failed' })).toBe(4); // original + 3 retries
    expect(await status()).toBe('past_due');
    await runBillingCycle(at(6));
    expect(await Payment.countDocuments({ status: 'failed' })).toBe(4); // no 4th retry
    expect((await runBillingCycle(at(7))).suspended).toBe(1);
    expect(await status()).toBe('suspended');

    const pay = await buy(o, 'starter', 'monthly', { card: CARD });
    expect(pay.status).toBe(201);
    expect(await status()).toBe('active');
  });

  it('a retry that succeeds brings the shop back to active', async () => {
    const o = await signup('o@x.lk');
    await buy(o, 'starter', 'monthly', { card: { number: '4000000000009995' } });
    const end = (await Tenant.findById(o.user.tenant._id)).subscription.currentPeriodEnd;
    await runBillingCycle(new Date(end.getTime() + 1000));
    await api('put', '/api/billing/payment-method', o.token).send(CARD);
    expect((await runBillingCycle(new Date(end.getTime() + DAY + 1000))).recovered).toBe(1);
    expect((await Tenant.findById(o.user.tenant._id)).status).toBe('active');
  });

  it('a trial that runs out becomes expired and read-only', async () => {
    const o = await signup('o@x.lk');
    expect((await runBillingCycle(later(15))).expired).toBe(1);
    expect((await api('get', '/api/billing/summary', o.token)).body.data.state).toBe('suspended');
  });
});

describe('public website hooks (WEB-03 to WEB-06)', () => {
  it('lists plans for the pricing page without logging in', async () => {
    const r = await api('get', '/api/public/plans');
    expect(r.body.data.map((p) => p.code)).toEqual(['lite', 'starter', 'growth', 'business']); // Unlimited is hidden
    expect(r.body.data[2].prices.monthly).toEqual({ USD: 40, LKR: 12000 });
  });

  it('contact and demo forms create leads; the honeypot and past dates are rejected', async () => {
    const { Lead } = await import('../src/modules/growth/growth.models.js');
    expect((await api('post', '/api/public/contact').send({ name: 'A', email: 'a@b.lk', message: 'Hi' })).status).toBe(201);
    expect((await api('post', '/api/public/demo').send({ name: 'A', email: 'a@b.lk', preferredAt: later(3) })).status).toBe(201);
    expect((await api('post', '/api/public/demo').send({ name: 'A', email: 'a@b.lk', preferredAt: later(-3) })).status).toBe(400);
    await api('post', '/api/public/contact').send({ name: 'Bot', email: 'bot@b.lk', website: 'http://spam' });
    expect(await Lead.countDocuments()).toBe(2);
  });
});
