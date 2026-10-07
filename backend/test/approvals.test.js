import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import request from 'supertest';
import User from '../src/modules/users/User.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import { createApp } from '../src/app.js';
import Customer from '../src/modules/customers/Customer.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const setPin = (id, pin) => runAsPlatform(async () => User.updateOne({ _id: id }, { approvalPinHash: await bcrypt.hash(pin, 4) }));

async function setupShop(email, name) {
  const shop = await signup(email, name);
  const me = (await api('get', '/api/auth/me', shop.token)).body.data;
  const tenantId = me.tenant._id;
  await setPin(me._id, '9999');
  await runWithContext({ tenantId }, async () =>
    FakeStock.create({ branchId: me.branchIds[0], barcode: 'BC-CASE-1', name: 'Silicone Case', sellingPriceCents: 5000, costPriceCents: 2000, qty: 50 })
  );
  return { ...shop, tenantId, userId: me._id };
}

const tradeInSale = (token, tradeInValueCents, extra = {}) =>
  api('post', '/api/pos/checkout', token).send({
    lines: [{ name: 'Silicone Case', barcode: 'BC-CASE-1', qty: 1, unitPriceCents: 5000 }],
    tradeInValueCents,
    tradeIn: { imei: '490154203237518', modelName: 'Galaxy A10' },
    customerNic: '200012345678',
    payments: [{ method: 'cash', amountCents: 5000 - tradeInValueCents }],
    ...extra,
  });

describe('Q24 trade-in limit per role', () => {
  it('defaults: branch manager Rs 50,000, cashier 0; manager under the limit needs no PIN, over it does', async () => {
    const shop = await setupShop('tradein-limit@shop.lk', 'Trade-in Limit Shop');
    const manager = await addStaff(shop, 'branch_manager', 'mgr-tradein@shop.lk');
    const cashier = await addStaff(shop, 'cashier', 'cash-tradein@shop.lk');

    const roles = (await api('get', '/api/roles', shop.token)).body.data;
    const byKey = Object.fromEntries(roles.map((r) => [r.key, r]));
    expect(byKey.branch_manager.tradeInLimitCents).toBe(5_000_000);
    expect(byKey.cashier.tradeInLimitCents).toBe(0);

    expect((await tradeInSale(manager.token, 1000)).status).toBe(201);

    // cashier: any trade-in needs a PIN
    const cashierNoPin = await tradeInSale(cashier.token, 1000);
    expect(cashierNoPin.status).toBe(403);
    expect(cashierNoPin.body.code).toBe('TRADE_IN_APPROVAL_REQUIRED');
    expect((await tradeInSale(cashier.token, 1000, { managerPin: '9999' })).status).toBe(201);

    // roles API saves the field; manager is now over the limit
    const upd = await api('put', `/api/roles/${byKey.branch_manager._id}`, shop.token).send({ tradeInLimitCents: 500 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.tradeInLimitCents).toBe(500);
    expect((await tradeInSale(manager.token, 400)).status).toBe(201);
    const over = await tradeInSale(manager.token, 1000);
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('TRADE_IN_APPROVAL_REQUIRED');
    expect((await tradeInSale(manager.token, 1000, { managerPin: '9999' })).status).toBe(201);

    for (const bad of [-1, 1.5, 'abc']) {
      const res = await api('put', `/api/roles/${byKey.cashier._id}`, shop.token).send({ tradeInLimitCents: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('Q25 shared approval-PIN service', () => {
  const verify = (token, body, app) => {
    const r = app ? request(app).post('/api/users/verify-pin') : api('post', '/api/users/verify-pin');
    return r.set('Authorization', `Bearer ${token}`).send(body);
  };
  const auditCount = (tenantId, action) => runWithContext({ tenantId }, async () => AuditLog.countDocuments({ action }));

  it('locks the requesting user after 5 wrong PINs, stored in the database', async () => {
    const shop = await setupShop('pin-lock@shop.lk', 'PIN Lock Shop');
    const cashier = await addStaff(shop, 'cashier', 'cash-lock@shop.lk');

    for (let i = 0; i < 5; i++) {
      const res = await verify(cashier.token, { pin: '0000' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INVALID_PIN');
    }
    const locked = await verify(cashier.token, { pin: '9999' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('PIN_LOCKED');
    expect(await auditCount(shop.tenantId, 'pin.verify_failed')).toBe(5);
    expect(await auditCount(shop.tenantId, 'pin.locked')).toBe(1);

    // a fresh app instance still sees the lock (not kept in memory)
    expect((await verify(cashier.token, { pin: '9999' }, createApp())).status).toBe(429);

    // the POS adapter uses the same lock
    const sale = await tradeInSale(cashier.token, 1000, { managerPin: '9999' });
    expect(sale.status).toBe(429);

    // the owner (a different requester) is not locked
    const owner = await verify(shop.token, { pin: '9999' });
    expect(owner.status).toBe(200);
    expect(owner.body.data.approverId).toBe(String(shop.userId));
  });

  it('a correct PIN resets the counter; PIN only in the body', async () => {
    const shop = await setupShop('pin-reset@shop.lk', 'PIN Reset Shop');
    const cashier = await addStaff(shop, 'cashier', 'cash-reset@shop.lk');
    for (let i = 0; i < 4; i++) expect((await verify(cashier.token, { pin: '0000' })).status).toBe(403);
    expect((await verify(cashier.token, { pin: '9999' })).status).toBe(200);
    const stored = await runAsPlatform(async () => User.findById(cashier.id).select('+pinFailedAttempts').lean());
    expect(stored.pinFailedAttempts).toBe(0);
    for (let i = 0; i < 4; i++) expect((await verify(cashier.token, { pin: '0000' })).status).toBe(403);
    expect((await verify(cashier.token, { pin: '9999' })).status).toBe(200);

    expect((await api('post', '/api/users/verify-pin?pin=9999', cashier.token).send({})).status).toBe(400);
    expect((await verify(cashier.token, { pin: '9999', special: 'not_a_special' })).status).toBe(400);
  });

  it("a cashier's own PIN does not approve; another tenant's manager PIN does not work", async () => {
    const shopA = await setupShop('pin-a@shop.lk', 'PIN Shop A');
    const shopB = await setupShop('pin-b@shop.lk', 'PIN Shop B');
    const cashierA = await addStaff(shopA, 'cashier', 'cash-a@shop.lk');
    const managerA = await addStaff(shopA, 'branch_manager', 'mgr-a@shop.lk');
    const cashierB = await addStaff(shopB, 'cashier', 'cash-b@shop.lk');
    await setPin(cashierA.id, '1111');
    await setPin(managerA.id, '2222');

    expect((await verify(cashierA.token, { pin: '1111' })).status).toBe(403);
    const ok = await verify(cashierA.token, { pin: '2222' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.approverId).toBe(String(managerA.id));
    expect((await verify(cashierB.token, { pin: '2222' })).status).toBe(403);
  });
});

describe('Q26 credit eligibility PIN is never read from the query string', () => {
  it('GET ?pin= approves nothing; POST with a manager PIN in the body approves', async () => {
    const shop = await setupShop('elig-pin@shop.lk', 'Eligibility PIN Shop');
    const cashier = await addStaff(shop, 'cashier', 'cash-elig@shop.lk');
    await runAsPlatform(async () => Tenant.updateOne({ _id: shop.tenantId }, { planCode: 'starter' }));
    const customer = await runWithContext({ tenantId: shop.tenantId }, async () =>
      Customer.create({ name: 'Nimal Perera', phone: '0771234567', nic: '199012345678', creditLimitCents: 100000, currentBalanceCents: 0 })
    );
    const url = `/api/pos/credit/customers/${customer._id}/eligibility`;

    const plain = await api('get', `${url}?requestedAmountCents=50000`, cashier.token);
    expect(plain.status).toBe(200);
    expect(plain.body.data.eligible).toBe(true);

    const viaQuery = await api('get', `${url}?requestedAmountCents=150000&pin=9999`, cashier.token);
    expect(viaQuery.status).toBe(400);
    expect(viaQuery.body.code).toBe('V-07');

    const wrong = await api('post', url, cashier.token).send({ pin: '0000', amountCents: 150000 });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('V-07');

    const approved = await api('post', url, cashier.token).send({ pin: '9999', amountCents: 150000 });
    expect(approved.status).toBe(200);
    expect(approved.body.data.approvedBy).toBe(String(shop.userId));
    expect(approved.body.data.overLimitByCents).toBe(50000);
  });
});
