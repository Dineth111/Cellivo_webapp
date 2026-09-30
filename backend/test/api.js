import request from 'supertest';
import { createApp } from '../src/app.js';
import { runAsPlatform } from '../src/core/tenantContext.js';
import User from '../src/modules/users/User.model.js';
import Session from '../src/modules/auth/Session.model.js';
import * as authSvc from '../src/modules/auth/auth.service.js';

export const app = createApp();
export const PASSWORD = 'Passw0rdX';

export const api = (method, url, token) => {
  const r = request(app)[method](url);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

/** Register a new shop; returns { token, refreshToken, user, email }. */
export async function signup(email, shopName = 'Test Shop') {
  const res = await api('post', '/api/auth/register').send({ name: 'Owner Person', shopName, email, password: PASSWORD, phone: '0771234567' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, email };
}

export const login = (email, password = PASSWORD) => api('post', '/api/auth/login').send({ email, password });

/** Owner invites a staff member with a role key and gets a logged-in token back. */
export async function addStaff(owner, roleKey, email) {
  const roles = (await api('get', '/api/roles', owner.token)).body.data;
  const branches = (await api('get', '/api/branches', owner.token)).body.data;
  const role = roles.find((r) => r.key === roleKey);
  const invited = await api('post', '/api/users', owner.token).send({ name: `${roleKey} person`, email, roleId: role._id, branchIds: [branches[0]._id] });
  if (invited.status !== 201) throw new Error(`invite failed ${invited.status} ${JSON.stringify(invited.body)}`);
  // the invitation token is only mailed, so tests issue a fresh one through the service
  const token = await runAsPlatform(async () => {
    const u = await User.findOne({ email });
    return authSvc.issueToken(u._id, 'invite', 60);
  });
  const set = await api('post', '/api/auth/set-password').send({ token, password: PASSWORD });
  if (set.status !== 200) throw new Error(`set-password failed ${set.status}`);
  const res = await login(email);
  return { token: res.body.token, user: res.body.user, id: invited.body.data._id, email };
}

export const sessionsOf = (userId) => runAsPlatform(async () => await Session.find({ userId }));
