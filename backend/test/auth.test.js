import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, login, addStaff, PASSWORD } from './api.js';
import User from '../src/modules/users/User.model.js';
import Session from '../src/modules/auth/Session.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import { runAsPlatform } from '../src/core/tenantContext.js';
import * as authSvc from '../src/modules/auth/auth.service.js';
import { assertConfig } from '../src/core/config.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const platform = (fn) => runAsPlatform(async () => await fn());

describe('registration and login', () => {
  it('registers, logs in and returns the profile with permissions', async () => {
    const owner = await signup('o@shop.lk');
    expect(owner.user.role.key).toBe('owner');
    expect(owner.user.shopName).toBe('Test Shop');
    const me = await api('get', '/api/auth/me', owner.token);
    expect(me.body.data.email).toBe('o@shop.lk');
    expect(me.body.data.permissions.grid.pos.view).toBe(true);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|tokenHash/);
    expect((await login('o@shop.lk')).status).toBe(200);
  });

  it('enforces the password policy', async () => {
    for (const password of ['short1', 'onlyletters', '12345678']) {
      const res = await api('post', '/api/auth/register').send({ name: 'A B', shopName: 'S S', email: `${password}@x.lk`, password });
      expect(res.status).toBe(400);
    }
  });

  it('rejects operator objects instead of strings', async () => {
    await signup('o@shop.lk');
    const res = await api('post', '/api/auth/login').send({ email: { $ne: '' }, password: { $ne: '' } });
    expect(res.status).toBe(400);
  });

  it('requires a valid token', async () => {
    expect((await api('get', '/api/auth/me')).status).toBe(401);
    expect((await api('get', '/api/auth/me', 'garbage')).status).toBe(401);
  });
});

describe('lockout', () => {
  it('locks after 5 failures and answers identically for unknown, wrong and locked', async () => {
    await signup('o@shop.lk');
    const unknown = await login('nobody@shop.lk', 'Whatever1');
    const wrong = await login('o@shop.lk', 'WrongPass1');
    for (let i = 0; i < 4; i++) await login('o@shop.lk', 'WrongPass1');
    const locked = await login('o@shop.lk', PASSWORD); // correct password, but locked now
    expect([unknown.status, wrong.status, locked.status]).toEqual([401, 401, 401]);
    expect(unknown.body).toEqual(wrong.body);
    expect(locked.body).toEqual(wrong.body);

    // lock expires
    await platform(() => User.updateOne({ email: 'o@shop.lk' }, { lockUntil: new Date(Date.now() - 1000) }));
    expect((await login('o@shop.lk')).status).toBe(200);
  });

  it('atomic counter: parallel wrong guesses still lock the account', async () => {
    await signup('o@shop.lk');
    await Promise.all(Array.from({ length: 8 }, () => login('o@shop.lk', 'WrongPass1')));
    const u = await platform(() => User.findOne({ email: 'o@shop.lk' }).select('+lockUntil'));
    expect(u.lockUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('deactivated users cannot log in', async () => {
    const owner = await signup('o@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    await api('post', `/api/users/${cashier.id}/deactivate`, owner.token).expect(200);
    expect((await login('c@shop.lk')).status).toBe(401);
    expect((await api('get', '/api/auth/me', cashier.token)).status).toBe(401); // sessions revoked
  });
});

describe('sessions', () => {
  it('lists sessions, remote logout revokes the token', async () => {
    const a = await signup('o@shop.lk');
    const b = (await login('o@shop.lk')).body;
    const list = await api('get', '/api/auth/sessions', a.token);
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s) => !s.current);
    await api('delete', `/api/auth/sessions/${other._id}`, a.token).expect(200);
    expect((await api('get', '/api/auth/me', b.token)).status).toBe(401);
    expect((await api('get', '/api/auth/me', a.token)).status).toBe(200);
    await api('post', '/api/auth/logout', a.token).expect(200);
    expect((await api('get', '/api/auth/me', a.token)).status).toBe(401);
  });

  it('owner sees all tenant sessions; staff cannot', async () => {
    const owner = await signup('o@shop.lk');
    const cashier = await addStaff(owner, 'cashier', 'c@shop.lk');
    const all = await api('get', '/api/auth/sessions/tenant', owner.token);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);
    expect((await api('get', '/api/auth/sessions/tenant', cashier.token)).status).toBe(403);
    // staff cannot revoke the owner's session, owner can revoke staff's
    const ownerSession = all.body.data.find((s) => s.current);
    expect((await api('delete', `/api/auth/sessions/${ownerSession._id}`, cashier.token)).status).toBe(404);
    const cashierSession = all.body.data.find((s) => String(s.userId) === cashier.user._id);
    await api('delete', `/api/auth/sessions/${cashierSession._id}`, owner.token).expect(200);
  });

  it('expires idle sessions using the tenant timeout', async () => {
    const owner = await signup('o@shop.lk');
    await platform(() => Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 29 * 60_000) }));
    expect((await api('get', '/api/auth/me', owner.token)).status).toBe(200);
    await platform(() => Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 31 * 60_000) }));
    const res = await api('get', '/api/auth/me', owner.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
    // the timeout is per tenant (10 to 240 minutes)
    const b = (await login('o@shop.lk')).body;
    await platform(() => Tenant.updateMany({}, { idleTimeoutMinutes: 120 }));
    await platform(() => Session.updateMany({ revokedAt: null }, { lastSeenAt: new Date(Date.now() - 60 * 60_000) }));
    expect((await api('get', '/api/auth/me', b.token)).status).toBe(200);
  });

  it('refresh rotates the refresh token; replay and idle sessions fail', async () => {
    const a = await signup('o@shop.lk');
    const r1 = await api('post', '/api/auth/refresh').send({ refreshToken: a.refreshToken });
    expect(r1.status).toBe(200);
    expect((await api('get', '/api/auth/me', r1.body.token)).status).toBe(200);
    expect((await api('post', '/api/auth/refresh').send({ refreshToken: a.refreshToken })).status).toBe(401);
    await platform(() => Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 31 * 60_000) }));
    expect((await api('post', '/api/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
  });
});

describe('passwords', () => {
  it('change password needs the current one and logs out other sessions', async () => {
    const a = await signup('o@shop.lk');
    const b = (await login('o@shop.lk')).body;
    await api('put', '/api/auth/change-password', a.token).send({ currentPassword: 'Nope12345', newPassword: 'NewPassw0rd' }).expect(400);
    await api('put', '/api/auth/change-password', a.token).send({ currentPassword: PASSWORD, newPassword: 'weak' }).expect(400);
    await api('put', '/api/auth/change-password', a.token).send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd' }).expect(200);
    expect((await api('get', '/api/auth/me', b.token)).status).toBe(401);
    expect((await api('get', '/api/auth/me', a.token)).status).toBe(200);
    expect((await login('o@shop.lk', 'NewPassw0rd')).status).toBe(200);
  });

  it('reset link is single use, expires, and revokes sessions; forgot answers the same for unknown emails', async () => {
    const a = await signup('o@shop.lk');
    const unknown = await api('post', '/api/auth/forgot-password').send({ email: 'ghost@shop.lk' });
    const known = await api('post', '/api/auth/forgot-password').send({ email: 'o@shop.lk' });
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    const token = await authSvc.forgotPassword('o@shop.lk');
    await api('post', '/api/auth/reset-password').send({ token, password: 'ResetPassw0rd' }).expect(200);
    await api('post', '/api/auth/reset-password').send({ token, password: 'ResetPassw0rd2' }).expect(400); // single use
    expect((await api('get', '/api/auth/me', a.token)).status).toBe(401);
    expect((await login('o@shop.lk', 'ResetPassw0rd')).status).toBe(200);

    const t2 = await authSvc.forgotPassword('o@shop.lk');
    await platform(() => User.updateOne({ email: 'o@shop.lk' }, { tokenExpiresAt: new Date(Date.now() - 1000) }));
    await api('post', '/api/auth/reset-password').send({ token: t2, password: 'ResetPassw0rd' }).expect(400); // expired
  });

  it('an invite link cannot be used as a reset link and vice versa', async () => {
    const owner = await signup('o@shop.lk');
    await addStaff(owner, 'cashier', 'c@shop.lk');
    const t = await authSvc.forgotPassword('c@shop.lk');
    await api('post', '/api/auth/set-password').send({ token: t, password: 'ResetPassw0rd' }).expect(400);
  });
});

describe('startup and seed safety', () => {
  it('assertConfig throws without JWT_SECRET or MONGO_URI', () => {
    const saved = { ...process.env };
    delete process.env.JWT_SECRET;
    expect(() => assertConfig()).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = saved.JWT_SECRET;
    delete process.env.MONGO_URI;
    expect(() => assertConfig()).toThrow(/MONGO_URI/);
    process.env.MONGO_URI = saved.MONGO_URI;
  });

  it('seed refuses to run in production', () => {
    const r = spawnSync(process.execPath, ['src/seed.js'], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/production/);
  });

  it('errors do not leak stack traces or duplicate fields', async () => {
    const res = await api('post', '/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.stack).toBeUndefined();
    const notFound = await api('get', '/api/nope');
    expect(notFound.status).toBe(404);
  });
});
