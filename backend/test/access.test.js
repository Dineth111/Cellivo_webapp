import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { protect } from '../src/core/auth.js';
import { requirePermission, requireSpecial } from '../src/core/permissions.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

// Tiny app exercising the guards other developers will use on their own routes.
const guarded = express();
guarded.get('/cost', protect, requireSpecial('view_cost_margin'), (req, res) => res.json({ ok: true }));
guarded.get('/inventory', protect, requirePermission('inventory.view'), (req, res) => res.json({ ok: true }));
guarded.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
const g = (url, token) => request(guarded).get(url).set('Authorization', `Bearer ${token}`);

describe('permission guards', () => {
  it('cashier: no roles, no staff, no cost/margin; may view inventory', async () => {
    const owner = await signup('o@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    expect((await api('get', '/api/roles', cashier.token)).status).toBe(403);
    expect((await api('post', '/api/roles', cashier.token).send({ name: 'Boss' })).status).toBe(403);
    expect((await api('get', '/api/users', cashier.token)).status).toBe(403);
    expect((await g('/cost', cashier.token)).status).toBe(403);
    expect((await g('/inventory', cashier.token)).status).toBe(200);
    expect((await g('/cost', owner.token)).status).toBe(200);
  });

  it('manager and accountant get view_cost_margin; technician does not', async () => {
    const owner = await signup('o@shop.lk');
    const mgr = await addStaff(owner, 'branch_manager', 'm@shop.lk');
    const acc = await addStaff(owner, 'accountant', 'a@shop.lk');
    const tech = await addStaff(owner, 'technician', 't@shop.lk');
    expect((await g('/cost', mgr.token)).status).toBe(200);
    expect((await g('/cost', acc.token)).status).toBe(200);
    expect((await g('/cost', tech.token)).status).toBe(403);
  });

  it('permission changes apply immediately, and unknown permission names are rejected at startup', async () => {
    const owner = await signup('o@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    const role = (await api('get', '/api/roles', owner.token)).body.data.find((r) => r.key === 'cashier');
    expect(role.discountLimitPercent).toBe(5);
    await api('put', `/api/roles/${role._id}`, owner.token).send({ special: { view_cost_margin: true }, grid: { inventory: { view: false } }, bogus: 1 }).expect(200);
    expect((await g('/cost', cashier.token)).status).toBe(200);
    expect((await g('/inventory', cashier.token)).status).toBe(403);
    expect(() => requirePermission('nope.view')).toThrow();
    expect(() => requireSpecial('nope')).toThrow();
  });
});

describe('roles', () => {
  it('owner role cannot be edited or deleted; default roles cannot be deleted', async () => {
    const owner = await signup('o@shop.lk');
    const roles = (await api('get', '/api/roles', owner.token)).body.data;
    expect(roles).toHaveLength(5);
    const ownerRole = roles.find((r) => r.key === 'owner');
    expect((await api('put', `/api/roles/${ownerRole._id}`, owner.token).send({ grid: { pos: { view: false } } })).status).toBe(400);
    expect((await api('delete', `/api/roles/${ownerRole._id}`, owner.token)).status).toBe(400);
    const cashier = roles.find((r) => r.key === 'cashier');
    expect((await api('delete', `/api/roles/${cashier._id}`, owner.token)).status).toBe(400);
  });

  it('custom roles: create, duplicate name, in-use delete blocked, then delete', async () => {
    const owner = await signup('o@shop.lk');
    const created = await api('post', '/api/roles', owner.token).send({ name: 'Stock clerk', grid: { inventory: { view: true, edit: true } }, discountLimitPercent: 3 });
    expect(created.status).toBe(201);
    expect(created.body.data.grid.inventory.edit).toBe(true);
    expect(created.body.data.grid.pos.view).toBe(false);
    expect((await api('post', '/api/roles', owner.token).send({ name: 'Stock clerk' })).status).toBe(409);
    expect((await api('post', '/api/roles', owner.token).send({ name: 'X', discountLimitPercent: 500 })).status).toBe(400);

    const branches = (await api('get', '/api/branches', owner.token)).body.data;
    const user = await api('post', '/api/users', owner.token).send({ name: 'Clerk One', email: 'k@shop.lk', roleId: created.body.data._id, branchIds: [branches[0]._id] });
    expect(user.status).toBe(201);
    expect((await api('delete', `/api/roles/${created.body.data._id}`, owner.token)).status).toBe(409);
    await api('post', `/api/users/${user.body.data._id}/deactivate`, owner.token).expect(200);
    await api('put', `/api/users/${user.body.data._id}`, owner.token).send({ roleId: (await api('get', '/api/roles', owner.token)).body.data.find((r) => r.key === 'cashier')._id }).expect(200);
    await api('delete', `/api/roles/${created.body.data._id}`, owner.token).expect(200);
  });
});

describe('users', () => {
  it('validates input; invited users cannot log in until they set a password', async () => {
    const owner = await signup('o@shop.lk');
    const roles = (await api('get', '/api/roles', owner.token)).body.data;
    const branches = (await api('get', '/api/branches', owner.token)).body.data;
    const cashierRole = roles.find((r) => r.key === 'cashier');
    const base = { name: 'New Cashier', email: 'n@shop.lk', roleId: cashierRole._id, branchIds: [branches[0]._id] };
    expect((await api('post', '/api/users', owner.token).send({ ...base, branchIds: [] })).status).toBe(400);
    expect((await api('post', '/api/users', owner.token).send({ ...base, roleId: 'x' })).status).toBe(400);
    expect((await api('post', '/api/users', owner.token).send({ ...base, approvalPin: '12' })).status).toBe(400);
    const ok = await api('post', '/api/users', owner.token).send({ ...base, approvalPin: '1234', discountLimit: 7 });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toMatch(/approvalPinHash|passwordHash|tokenHash/);
    expect((await api('post', '/api/auth/login').send({ email: 'n@shop.lk', password: 'Passw0rdX' })).status).toBe(401);
    expect((await api('post', '/api/users', owner.token).send(base)).status).toBe(409); // duplicate email
  });

  it('the last active owner cannot be deactivated or demoted; a second owner unlocks it', async () => {
    const owner = await signup('o@shop.lk');
    const roles = (await api('get', '/api/roles', owner.token)).body.data;
    const ownerRole = roles.find((r) => r.key === 'owner');
    const cashierRole = roles.find((r) => r.key === 'cashier');
    const me = owner.user._id;
    let res = await api('post', `/api/users/${me}/deactivate`, owner.token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_OWNER');
    expect((await api('put', `/api/users/${me}`, owner.token).send({ roleId: cashierRole._id })).status).toBe(409);

    const branches = (await api('get', '/api/branches', owner.token)).body.data;
    const second = await api('post', '/api/users', owner.token).send({ name: 'Second Owner', email: 's@shop.lk', roleId: ownerRole._id, branchIds: [branches[0]._id] });
    expect(second.status).toBe(201);
    await api('post', `/api/users/${me}/deactivate`, owner.token).expect(200);
  });

  it('a manager cannot assign or touch the Owner role', async () => {
    const owner = await signup('o@shop.lk');
    const mgr = await addStaff(owner, 'branch_manager', 'm@shop.lk');
    // managers only have staff.view by default; grant edit/create to prove the owner-role rule itself
    const roles = (await api('get', '/api/roles', owner.token)).body.data;
    await api('put', `/api/roles/${roles.find((r) => r.key === 'branch_manager')._id}`, owner.token).send({ grid: { staff: { create: true, edit: true } } });
    const ownerRole = roles.find((r) => r.key === 'owner');
    const branches = (await api('get', '/api/branches', mgr.token)).body.data;
    expect((await api('post', '/api/users', mgr.token).send({ name: 'Sneaky', email: 'x@shop.lk', roleId: ownerRole._id, branchIds: [branches[0]._id] })).status).toBe(403);
    expect((await api('post', `/api/users/${owner.user._id}/deactivate`, mgr.token)).status).toBe(403);
  });
});

describe('audit log', () => {
  it('records security events and never stores secrets', async () => {
    const owner = await signup('o@shop.lk');
    await api('post', '/api/auth/login').send({ email: 'o@shop.lk', password: 'WrongPass1' });
    await addStaff(owner, 'cashier', 'c@shop.lk');
    await api('post', '/api/roles', owner.token).send({ name: 'Extra' });
    const res = await api('get', '/api/audit?limit=100', owner.token);
    const actions = res.body.data.map((a) => a.action);
    for (const a of ['tenant.register', 'auth.login', 'auth.login_failed', 'user.create', 'auth.invite_accepted', 'role.create']) expect(actions).toContain(a);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|approvalPinHash|refreshToken|\$2[aby]\$/);
    const created = res.body.data.find((a) => a.action === 'user.create');
    expect(created.userId).toBe(owner.user._id);
    expect(created.ip).toBeTruthy();
  });

  it('filters, paginates and is owner-only', async () => {
    const owner = await signup('o@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    expect((await api('get', '/api/audit', cashier.token)).status).toBe(403);
    const byAction = await api('get', '/api/audit?action=auth.login', owner.token);
    expect(byAction.body.data.every((a) => a.action === 'auth.login')).toBe(true);
    const byUser = await api('get', `/api/audit?user=${cashier.user._id}`, owner.token);
    expect(byUser.body.data.every((a) => a.userId === cashier.user._id)).toBe(true);
    const page = await api('get', '/api/audit?limit=2&page=1', owner.token);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.total).toBeGreaterThan(2);
    const future = await api('get', `/api/audit?from=${new Date(Date.now() + 86400000).toISOString()}`, owner.token);
    expect(future.body.data).toHaveLength(0);
  });

  it('is append-only at the model level', async () => {
    const owner = await signup('o@shop.lk');
    const tenantId = (await api('get', '/api/auth/me', owner.token)).body.data.tenant._id;
    await runWithContext({ tenantId }, async () => {
      const entry = await AuditLog.findOne();
      await expect(AuditLog.updateOne({ _id: entry._id }, { action: 'x' })).rejects.toThrow(/append-only/);
      await expect(AuditLog.updateMany({}, { action: 'x' })).rejects.toThrow(/append-only/);
      await expect(AuditLog.findByIdAndUpdate(entry._id, { action: 'x' })).rejects.toThrow(/append-only/);
      await expect(AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
      await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(AuditLog.findByIdAndDelete(entry._id)).rejects.toThrow(/append-only/);
      entry.action = 'tampered';
      await expect(entry.save()).rejects.toThrow(/append-only/);
      await expect(entry.deleteOne()).rejects.toThrow(/append-only/);
      expect((await AuditLog.findById(entry._id)).action).not.toBe('tampered');
    });
  });
});

describe('customers', () => {
  it('whitelists fields, enforces unique phone per tenant, archives instead of deleting', async () => {
    const owner = await signup('o@shop.lk');
    const evil = new (await import('mongoose')).default.Types.ObjectId().toString();
    const c = await api('post', '/api/customers', owner.token).send({ name: 'Kasun', phone: '0771111111', tenantId: evil, isArchived: true, type: 'wholesale' });
    expect(c.status).toBe(201);
    expect(c.body.data.tenantId).not.toBe(evil);
    expect(c.body.data.isArchived).toBe(false);

    const dup = await api('post', '/api/customers', owner.token).send({ name: 'Other', phone: '0771111111' });
    expect(dup.status).toBe(409);
    expect(dup.body.data._id).toBe(c.body.data._id); // FRS F-13: show the existing customer

    const other = await api('post', '/api/customers', owner.token).send({ name: 'Other', phone: '0772222222' });
    expect((await api('put', `/api/customers/${other.body.data._id}`, owner.token).send({ phone: '0771111111' })).status).toBe(409);
    const upd = await api('put', `/api/customers/${c.body.data._id}`, owner.token).send({ name: 'Kasun S', tenantId: evil });
    expect(upd.body.data.name).toBe('Kasun S');

    await api('delete', `/api/customers/${c.body.data._id}`, owner.token).expect(200);
    expect((await api('get', '/api/customers', owner.token)).body.count).toBe(1);
    expect((await api('get', '/api/customers?archived=true', owner.token)).body.count).toBe(1);
    expect((await api('get', `/api/customers/${c.body.data._id}`, owner.token)).status).toBe(200); // still readable, not deleted
    expect((await api('get', '/api/customers?search=%5B', owner.token)).status).toBe(200); // regex chars are escaped
    expect((await api('get', '/api/customers/not-an-id', owner.token)).status).toBe(400);
  });

  it('technician cannot read customers; cashier can create but not delete', async () => {
    const owner = await signup('o@shop.lk');
    const tech = await addStaff(owner, 'technician', 't@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    expect((await api('get', '/api/customers', tech.token)).status).toBe(403);
    const c = await api('post', '/api/customers', cashier.token).send({ name: 'A B', phone: '0770000000' });
    expect(c.status).toBe(201);
    expect((await api('delete', `/api/customers/${c.body.data._id}`, cashier.token)).status).toBe(403);
  });
});
