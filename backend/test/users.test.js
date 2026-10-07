import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runAsPlatform } from '../src/core/tenantContext.js';
import User from '../src/modules/users/User.model.js';
import { verifyPassword } from '../src/core/password.js';

// Count PIN compares; behaviour stays the real bcrypt compare.
vi.mock('../src/core/password.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword) };
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

describe('approval PIN attempts are reserved before the compare', () => {
  it('10 parallel wrong PINs: at most 5 compares, then locked', async () => {
    const shop = await signup('pin-race@shop.lk', 'PIN Race Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    await runAsPlatform(async () => User.updateOne({ _id: me._id }, { approvalPinHash: await bcrypt.hash('9999', 4) }));
    const cashier = await addStaff(shop, 'cashier', 'cash-race@shop.lk');
    const verify = (pin) => api('post', '/api/users/verify-pin', cashier.token).send({ pin });

    verifyPassword.mockClear(); // logins above also compare
    const results = await Promise.all(Array.from({ length: 10 }, () => verify('0000')));
    const codes = results.map((r) => r.status).sort();

    expect(verifyPassword.mock.calls.length).toBeLessThanOrEqual(5); // one approver (the owner) per allowed attempt
    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429, 429, 429, 429]);
    const stored = await runAsPlatform(async () => User.findById(cashier.id).select('+pinLockedUntil').lean());
    expect(stored.pinLockedUntil.getTime()).toBeGreaterThan(Date.now());

    verifyPassword.mockClear();
    expect((await verify('9999')).status).toBe(429);
    expect(verifyPassword).not.toHaveBeenCalled(); // locked: no compare at all
  });
});
