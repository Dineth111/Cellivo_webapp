import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import { Invoice } from '../src/modules/billing/billing.models.js';
import { AdminUser, AdminAudit } from '../src/modules/admin/admin.models.js';
import { totp } from '../src/modules/admin/admin.auth.js';
import { hashPassword } from '../src/core/password.js';
import { config } from '../src/core/config.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const PW = 'Adm1nPassw0rd';
const mkAdmin = async (role = 'super_admin', email = `${role}@cellivo.lk`) =>
  AdminUser.create({ name: role, email, role, passwordHash: await hashPassword(PW) });

/** Full two-step login; the first login also enrols 2FA. Returns the session token. */
async function loginAs(role = 'super_admin') {
  const email = `${role}@cellivo.lk`;
  if (!(await AdminUser.exists({ email }))) await mkAdmin(role);
  const step1 = await api('post', '/api/admin/auth/login').send({ email, password: PW });
  const { challenge, twoFactorEnrolled } = step1.body.data;
  let secret;
  if (!twoFactorEnrolled) secret = (await api('post', '/api/admin/auth/enroll').send({ challenge })).body.data.secret;
  else secret = (await AdminUser.findOne({ email }).select('+totpSecret')).totpSecret;
  const step2 = await api('post', '/api/admin/auth/verify').send({ challenge, code: totp(secret) });
  expect(step2.status).toBe(200);
  return step2.body.data.token;
}

describe('admin login (mandatory 2FA)', () => {
  it('needs password, then a TOTP code; a tenant token never works', async () => {
    await mkAdmin();
    const wrong = await api('post', '/api/admin/auth/login').send({ email: 'super_admin@cellivo.lk', password: 'nope' });
    expect(wrong.status).toBe(401);

    const token = await loginAs();
    expect((await api('get', '/api/admin/me', token)).body.data.role).toBe('super_admin');
    expect((await api('get', '/api/admin/me')).status).toBe(401);

    const owner = await signup('o@x.lk');
    expect((await api('get', '/api/admin/me', owner.token)).status).toBe(401);
    expect((await api('get', '/api/billing/summary', token)).status).toBe(401); // and an admin token is no shop token
  });

  it('a wrong code is rejected and five wrong passwords lock the account', async () => {
    await mkAdmin();
    const { challenge } = (await api('post', '/api/admin/auth/login').send({ email: 'super_admin@cellivo.lk', password: PW })).body.data;
    await api('post', '/api/admin/auth/enroll').send({ challenge });
    expect((await api('post', '/api/admin/auth/verify').send({ challenge, code: '000000' })).status).toBe(401);
    for (let i = 0; i < 5; i++) await api('post', '/api/admin/auth/login').send({ email: 'super_admin@cellivo.lk', password: 'bad' });
    const locked = await api('post', '/api/admin/auth/login').send({ email: 'super_admin@cellivo.lk', password: PW });
    expect(locked.body.code).toBe('LOCKED');
  });

  it('the IP allow-list blocks other networks', async () => {
    await mkAdmin();
    config.adminIpAllowList = ['203.0.113.9'];
    try {
      const r = await api('post', '/api/admin/auth/login').send({ email: 'super_admin@cellivo.lk', password: PW });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('IP_BLOCKED');
    } finally { config.adminIpAllowList = []; }
  });
});

describe('roles and tenant management', () => {
  it('roles are enforced: sales cannot suspend, support can, and the reason is required', async () => {
    const owner = await signup('o@x.lk');
    const id = owner.user.tenant._id;
    const sales = await loginAs('sales');
    expect((await api('post', `/api/admin/tenants/${id}/suspend`, sales).send({ reason: 'x' })).status).toBe(403);

    const support = await loginAs('support');
    expect((await api('post', `/api/admin/tenants/${id}/suspend`, support).send({})).status).toBe(400);
    expect((await api('post', `/api/admin/tenants/${id}/suspend`, support).send({ reason: 'chargeback' })).status).toBe(200);
    expect((await Tenant.findById(id)).status).toBe('suspended');
    expect((await api('post', `/api/admin/tenants/${id}/reactivate`, support).send({ reason: 'paid' })).status).toBe(200);
    expect((await Tenant.findById(id)).status).toBe('trial');
    expect(await AdminAudit.countDocuments({ tenantId: id })).toBe(2);
  });

  it('extend trial, branch-limit override, sms credits and notes', async () => {
    const owner = await signup('o@x.lk');
    const id = owner.user.tenant._id;
    const t = await loginAs('super_admin');
    const before = (await Tenant.findById(id)).trialEndsAt;
    await api('post', `/api/admin/tenants/${id}/extend-trial`, t).send({ days: 7, reason: 'asked' });
    expect((await Tenant.findById(id)).trialEndsAt.getTime() - before.getTime()).toBe(7 * 864e5);
    expect((await api('post', `/api/admin/tenants/${id}/extend-trial`, t).send({ days: 0, reason: 'x' })).status).toBe(400);
    await api('post', `/api/admin/tenants/${id}/branch-limit`, t).send({ limit: 5, reason: 'enterprise deal' });
    await api('post', `/api/admin/tenants/${id}/sms-credits`, t).send({ delta: 100, reason: 'goodwill' });
    expect((await api('post', `/api/admin/tenants/${id}/sms-credits`, t).send({ delta: -500, reason: 'x' })).status).toBe(400);
    await api('post', `/api/admin/tenants/${id}/notes`, t).send({ text: 'called owner' });
    const d = (await api('get', `/api/admin/tenants/${id}`, t)).body.data;
    expect(d).toMatchObject({ branchLimitOverride: 5, smsCredits: 100, counts: { users: 1, branches: 1 } });
    expect(d.notes).toHaveLength(1);
    expect(d.paymentMethod.token).toBeUndefined();
  });

  it('offline payment activates a plan; finance can refund it, with a reason', async () => {
    const owner = await signup('o@x.lk');
    const id = owner.user.tenant._id;
    const fin = await loginAs('finance');
    const paid = await api('post', `/api/admin/tenants/${id}/offline-payment`, fin).send({ planCode: 'growth', term: 'monthly', currency: 'LKR', reference: 'BANK-1' });
    expect(paid.status).toBe(200);
    expect(await Tenant.findById(id)).toMatchObject({ planCode: 'growth', status: 'active' });
    const inv = await Invoice.findOne({ tenantId: id });
    expect((await api('post', `/api/admin/invoices/${inv._id}/refund`, fin).send({})).status).toBe(400);
    expect((await api('post', `/api/admin/invoices/${inv._id}/refund`, fin).send({ reason: 'duplicate' })).status).toBe(200);
    expect((await Invoice.findById(inv._id)).status).toBe('refunded');
  });

  it('lists and filters shops, lists plans, and the dashboard summarises', async () => {
    await signup('a@x.lk', 'Alpha Mobile');
    await signup('b@x.lk', 'Beta Mobile');
    const t = await loginAs();
    expect((await api('get', '/api/admin/tenants?q=alpha', t)).body.data).toHaveLength(1);
    expect((await api('get', '/api/admin/tenants?status=bogus', t)).status).toBe(400);
    expect((await api('get', '/api/admin/plans', t)).body.data.length).toBeGreaterThan(2);
    const dash = (await api('get', '/api/admin/dashboard', t)).body.data;
    expect(dash.tenantsByStatus.trial).toBe(2);
  });
});

describe('growth collections and admin users', () => {
  it('leads: sales can work them, content cannot; the body is whitelisted', async () => {
    const lead = (await api('post', '/api/public/contact').send({ name: 'Kamal', email: 'k@x.lk', message: 'hi' })).body;
    const sales = await loginAs('sales');
    const list = (await api('get', '/api/admin/leads', sales)).body.data;
    expect(list).toHaveLength(1);
    const upd = await api('put', `/api/admin/leads/${list[0]._id}`, sales).send({ status: 'contacted', email: 'hacker@x.lk' });
    expect(upd.body.data).toMatchObject({ status: 'contacted', email: 'k@x.lk' });
    const content = await loginAs('content');
    expect((await api('get', '/api/admin/leads', content)).status).toBe(403);
    expect(lead).toBeTruthy();
  });

  it('feature flags are super-admin only; only a super admin manages admins and cannot demote themselves', async () => {
    const support = await loginAs('support');
    expect((await api('post', '/api/admin/flags', support).send({ key: 'beta' })).status).toBe(403);
    expect((await api('get', '/api/admin/admins', support)).status).toBe(403);
    const root = await loginAs('super_admin');
    expect((await api('post', '/api/admin/flags', root).send({ key: 'beta', enabled: true })).status).toBe(201);
    const me = (await api('get', '/api/admin/me', root)).body.data;
    expect((await api('put', `/api/admin/admins/${me.id}`, root).send({ role: 'support' })).status).toBe(409);
    const made = await api('post', '/api/admin/admins', root).send({ name: 'New', email: 'n@cellivo.lk', role: 'sales', password: PW });
    expect(made.status).toBe(201);
    expect(made.body.data.passwordHash).toBeUndefined();
  });

  it('the platform audit log is append-only and readable by finance', async () => {
    const root = await loginAs();
    await api('post', '/api/admin/flags', root).send({ key: 'x' });
    const fin = await loginAs('finance');
    const log = (await api('get', '/api/admin/audit?action=flags.create', fin)).body.data;
    expect(log).toHaveLength(1);
    await expect(AdminAudit.updateOne({}, { action: 'tampered' })).rejects.toThrow('append-only');
  });
});
