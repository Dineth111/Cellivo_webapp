import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import FakeStock from '../src/modules/pos/models/FakeStock.model.js';
import User from '../src/modules/users/User.model.js';

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
