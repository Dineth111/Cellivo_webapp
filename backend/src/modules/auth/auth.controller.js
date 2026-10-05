import User from '../users/User.model.js';
import Session from './Session.model.js';
import { provisionTenant } from '../tenants/provisioning.service.js';
import * as auth from './auth.service.js';
import { createSession, refreshSession, revokeSession } from './session.service.js';
import { runWithContext } from '../../core/tenantContext.js';
import { badRequest, notFound } from '../../core/errors.js';
import { str, requireId } from '../../core/validate.js';
import audit from '../../core/audit.js';
import { config } from '../../core/config.js';

const meta = (req) => ({ ip: req.ip, device: req.get('user-agent') || '' });

// @route POST /api/auth/register
// TODO(Dev 2): the sign-up flow (email/phone verification, plan and billing term, coupon, setup wizard)
// replaces this endpoint. Until then it provisions a tenant on the trial and logs the owner in.
export const register = async (req, res) => {
  // Dev 2's /api/signup (email verification, plan, coupon) is the real sign-up. This shortcut skips
  // verification, so it only exists outside production (tests and local demos use it).
  if (config.env === 'production') throw notFound('Route not found');
  const { name, shopName, email, password, phone, country } = req.body || {};
  if (![name, shopName, email, password].every((v) => typeof v === 'string' && v.trim())) {
    throw badRequest('Please provide full name, shop name, email, and password');
  }
  const { tenant, user } = await provisionTenant({
    ownerName: name.trim(),
    shopName: shopName.trim(),
    email,
    phone: str(phone) || '',
    password,
    country: str(country) || undefined,
  });
  const out = await runWithContext({ tenantId: tenant._id, userId: user._id, ...meta(req) }, async () => {
    const s = await createSession(user, meta(req));
    await audit.record({ action: 'tenant.register', entity: 'Tenant', entityId: tenant._id });
    return { ...s, user: await auth.describeUser(user) };
  });
  res.status(201).json({ success: true, message: 'Account created successfully', token: out.token, refreshToken: out.refreshToken, user: out.user });
};

// @route POST /api/auth/login
export const login = async (req, res) => {
  const email = str(req.body?.email)?.toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
  if (!email || !password) throw badRequest('Please provide both email and password');
  const { user, token, refreshToken } = await auth.login({ email, password }, meta(req));
  const described = await runWithContext({ tenantId: user.tenantId }, async () => await auth.describeUser(user));
  res.json({ success: true, message: 'Logged in successfully', token, refreshToken, user: described });
};

// @route POST /api/auth/refresh  { refreshToken }
export const refresh = async (req, res) => {
  res.json({ success: true, ...(await refreshSession(req.body?.refreshToken)) });
};

// @route POST /api/auth/logout
export const logout = async (req, res) => {
  await revokeSession(req.auth.sessionId, 'logout');
  res.json({ success: true, message: 'Logged out' });
};

// @route GET /api/auth/me
export const getMe = async (req, res) => {
  res.json({ success: true, data: await auth.describeUser(req.user) });
};

// @route PUT /api/auth/profile  { name?, phone?, password?, currentPassword? }
export const updateProfile = async (req, res) => {
  const { password, currentPassword } = req.body || {};
  const before = { name: req.user.name, phone: req.user.phone };
  const update = {};
  if (str(req.body?.name)) update.name = str(req.body.name);
  if (str(req.body?.phone) !== undefined) update.phone = str(req.body.phone);
  const user = await User.findOneAndUpdate({ _id: req.user._id }, update, { new: true, runValidators: true });
  if (Object.keys(update).length) await audit.record({ action: 'user.profile_update', entity: 'User', entityId: user._id, before, after: update });
  if (password !== undefined) await auth.changePassword(user._id, req.auth.sessionId, currentPassword, password);
  res.json({ success: true, message: 'Profile updated successfully', user: await auth.describeUser(user) });
};

// @route PUT /api/auth/change-password  { currentPassword, newPassword }
export const changePassword = async (req, res) => {
  await auth.changePassword(req.user._id, req.auth.sessionId, req.body?.currentPassword, req.body?.newPassword);
  res.json({ success: true, message: 'Password changed. Other sessions were logged out.' });
};

// @route POST /api/auth/forgot-password  { email }
export const forgotPassword = async (req, res) => {
  const email = str(req.body?.email)?.toLowerCase();
  if (email) await auth.forgotPassword(email);
  res.json({ success: true, message: 'If an account exists for this email, a reset link has been sent.' });
};

// @route POST /api/auth/reset-password | /set-password  { token, password }
export const consume = (purpose) => async (req, res) => {
  await auth.consumeToken(req.body?.token, purpose, req.body?.password);
  res.json({ success: true, message: 'Password set. You can now log in.' });
};

const sessionView = (s, currentId) => ({
  _id: s._id, userId: s.userId, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt,
  current: String(s._id) === String(currentId),
});

// @route GET /api/auth/sessions  (mine)
export const mySessions = async (req, res) => {
  const list = await Session.find({ userId: req.user._id, revokedAt: null }).sort({ lastSeenAt: -1 });
  res.json({ success: true, data: list.map((s) => sessionView(s, req.auth.sessionId)) });
};

// @route GET /api/auth/sessions/tenant  (owner)
export const tenantSessions = async (req, res) => {
  const list = await Session.find({ revokedAt: null }).sort({ lastSeenAt: -1 }).limit(500);
  res.json({ success: true, data: list.map((s) => sessionView(s, req.auth.sessionId)) });
};

// @route DELETE /api/auth/sessions/:id  (own session, or any session of the tenant for the owner)
export const revoke = async (req, res) => {
  requireId(req.params.id, 'session id');
  const s = await Session.findById(req.params.id);
  if (!s || s.revokedAt || (String(s.userId) !== String(req.user._id) && req.auth.role.key !== 'owner')) throw notFound('Session not found');
  await revokeSession(s._id, 'remote_logout');
  res.json({ success: true, message: 'Session logged out' });
};
