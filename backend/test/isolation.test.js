import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext } from '../src/core/tenantContext.js';
import Customer from '../src/modules/customers/Customer.model.js';
import User from '../src/modules/users/User.model.js';
import Role from '../src/modules/roles/Role.model.js';
import Branch from '../src/modules/branches/Branch.model.js';
import Session from '../src/modules/auth/Session.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import LedgerAccount from '../src/modules/pos/models/LedgerAccount.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import InvoiceSequence from '../src/modules/pos/models/InvoiceSequence.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import Payment from '../src/modules/pos/models/Payment.model.js';
import HeldCart from '../src/modules/pos/models/HeldCart.model.js';
import Quotation from '../src/modules/pos/models/Quotation.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

// Add every new tenant-owned model here (see docs/architecture/tenancy.md).
const MODELS = {
  Customer,
  User,
  Role,
  Branch,
  Session,
  AuditLog,
  LedgerAccount,
  LedgerEntry,
  FakeStock,
  InvoiceSequence,
  Invoice,
  Payment,
  HeldCart,
  Quotation,
};

async function twoShops() {
  const a = await signup('a@shop.lk', 'Shop A');
  const b = await signup('b@shop.lk', 'Shop B');
  const tid = async (o) => (await api('get', '/api/auth/me', o.token)).body.data.tenant._id;
  return { a: { ...a, tenantId: await tid(a) }, b: { ...b, tenantId: await tid(b) } };
}

describe('tenant isolation over HTTP', () => {
  it("tenant B cannot list, read, update or archive tenant A's customers", async () => {
    const { a, b } = await twoShops();
    const c = (await api('post', '/api/customers', a.token).send({ name: 'Secret Customer', phone: '0771111111' })).body.data;

    expect((await api('get', '/api/customers', b.token)).body.count).toBe(0);
    expect((await api('get', `/api/customers/${c._id}`, b.token)).status).toBe(404);
    expect((await api('put', `/api/customers/${c._id}`, b.token).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api('delete', `/api/customers/${c._id}`, b.token)).status).toBe(404);
    // same phone number in another tenant is fine (uniqueness is per tenant)
    expect((await api('post', '/api/customers', b.token).send({ name: 'B Customer', phone: '0771111111' })).status).toBe(201);

    const still = (await api('get', `/api/customers/${c._id}`, a.token)).body.data;
    expect(still.name).toBe('Secret Customer');
    expect(still.isArchived).toBe(false);
  });

  it("tenant B cannot see or touch A's users, roles, branches, sessions or audit entries", async () => {
    const { a, b } = await twoShops();
    expect((await api('get', '/api/users', b.token)).body.data.map((u) => u.email)).toEqual(['b@shop.lk']);
    expect((await api('get', `/api/users/${a.user._id}`, b.token)).status).toBe(404);
    expect((await api('put', `/api/users/${a.user._id}`, b.token).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api('post', `/api/users/${a.user._id}/deactivate`, b.token)).status).toBe(404);

    const rolesA = (await api('get', '/api/roles', a.token)).body.data;
    const rolesB = (await api('get', '/api/roles', b.token)).body.data;
    expect(rolesB.every((r) => !rolesA.some((x) => x._id === r._id))).toBe(true);
    expect((await api('get', `/api/roles/${rolesA[0]._id}`, b.token)).status).toBe(404);
    expect((await api('put', `/api/roles/${rolesA[1]._id}`, b.token).send({ discountLimitPercent: 99 })).status).toBe(404);
    expect((await api('delete', `/api/roles/${rolesA[1]._id}`, b.token)).status).toBe(404);

    // cannot invite a user into B with A's role or A's branch
    const brA = (await api('get', '/api/branches', a.token)).body.data[0];
    const brB = (await api('get', '/api/branches', b.token)).body.data[0];
    expect(brA._id).not.toBe(brB._id);
    const cashierA = rolesA.find((r) => r.key === 'cashier');
    const cashierB = rolesB.find((r) => r.key === 'cashier');
    expect((await api('post', '/api/users', b.token).send({ name: 'Mole', email: 'm@shop.lk', roleId: cashierA._id, branchIds: [brB._id] })).status).toBe(400);
    expect((await api('post', '/api/users', b.token).send({ name: 'Mole', email: 'm@shop.lk', roleId: cashierB._id, branchIds: [brA._id] })).status).toBe(400);

    const sessionsA = (await api('get', '/api/auth/sessions', a.token)).body.data;
    expect((await api('delete', `/api/auth/sessions/${sessionsA[0]._id}`, b.token)).status).toBe(404);
    expect((await api('get', '/api/auth/sessions/tenant', b.token)).body.data.every((s) => s.userId === b.user._id)).toBe(true);

    const auditB = (await api('get', '/api/audit?limit=100', b.token)).body.data;
    expect(auditB.length).toBeGreaterThan(0);
    expect(auditB.every((e) => e.tenantId === b.tenantId)).toBe(true);
    expect(auditB.some((e) => e.userId === a.user._id)).toBe(false);

    // A is untouched
    expect((await api('get', '/api/auth/me', a.token)).body.data.name).toBe('Owner Person');
  });

  it("a token from tenant A never authorises tenant B's data even with forged ids in the body", async () => {
    const { a, b } = await twoShops();
    const res = await api('post', '/api/customers', b.token).send({ name: 'Forged', phone: '0779999999', tenantId: a.tenantId });
    expect(res.body.data.tenantId).toBe(b.tenantId);
    expect((await api('get', '/api/customers', a.token)).body.count).toBe(0);
  });
});

describe('tenant isolation at the model layer', () => {
  it('every tenant model: find, count, aggregate and update are scoped; no context throws', async () => {
    const { a, b } = await twoShops();
    await api('post', '/api/customers', a.token).send({ name: 'A1', phone: '0771111111' });
    const asB = (fn) => runWithContext({ tenantId: b.tenantId }, async () => await fn());

    for (const [name, Model] of Object.entries(MODELS)) {
      await expect(Model.find()).rejects.toThrow(/Tenant context missing/);
      await expect(Model.findOne()).rejects.toThrow(/Tenant context missing/);
      await expect(Model.countDocuments()).rejects.toThrow(/Tenant context missing/);
      await expect(Model.aggregate([{ $match: {} }])).rejects.toThrow(/Tenant context missing/);

      const docs = await asB(() => Model.find());
      expect(docs.every((d) => String(d.tenantId) === b.tenantId), `${name} leaked`).toBe(true);
      const agg = await asB(() => Model.aggregate([{ $group: { _id: '$tenantId', n: { $sum: 1 } } }]));
      expect(agg.every((g) => String(g._id) === b.tenantId), `${name} aggregate leaked`).toBe(true);
    }
    expect(await asB(() => Customer.find())).toHaveLength(0);
    expect(await asB(() => User.countDocuments())).toBe(1);
    expect((await asB(() => Customer.updateMany({}, { name: 'x' }))).matchedCount).toBe(0);
  });
});
