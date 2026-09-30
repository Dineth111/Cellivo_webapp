import User from '../users/User.model.js';
import Role from '../roles/Role.model.js';
import Tenant from '../tenants/Tenant.model.js';
import { runAsPlatform, runWithContext } from '../../core/tenantContext.js';
import { hashPassword, verifyPassword, passwordError, newToken, hashToken } from '../../core/password.js';
import { badRequest, unauthorized } from '../../core/errors.js';
import { config } from '../../core/config.js';
import audit from '../../core/audit.js';
import { createSession, revokeUserSessions } from './session.service.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
// One message for unknown email, wrong password, locked and deactivated accounts (no enumeration).
export const LOGIN_FAILED = 'Invalid email or password';

let dummyHash; // compared against when the email is unknown so timing does not reveal it

export async function login({ email, password }, meta = {}) {
  const user = await runAsPlatform(async () => await User.findOne({ email }).select('+passwordHash +lockUntil'));
  if (!user) {
    dummyHash ??= await hashPassword('dummy-password-1');
    await verifyPassword(password, dummyHash);
    throw unauthorized(LOGIN_FAILED);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  const locked = user.lockUntil && user.lockUntil > new Date();

  return runWithContext({ tenantId: user.tenantId, userId: user._id, ip: meta.ip, device: meta.device }, async () => {
    if (locked) {
      await audit.record({ action: 'auth.login_blocked', entity: 'User', entityId: user._id, after: { reason: 'locked' } });
      throw unauthorized(LOGIN_FAILED);
    }
    if (!ok) {
      // atomic increment: concurrent guesses cannot slip past the limit
      const u = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { new: true }).select('+failedLogins');
      await audit.record({ action: 'auth.login_failed', entity: 'User', entityId: user._id });
      if (u.failedLogins >= MAX_FAILED_LOGINS) {
        const r = await User.updateOne(
          { _id: user._id, failedLogins: { $gte: MAX_FAILED_LOGINS } },
          { $set: { lockUntil: new Date(Date.now() + LOCK_MINUTES * 60_000), failedLogins: 0 } }
        );
        if (r.modifiedCount) {
          await audit.record({ action: 'auth.account_locked', entity: 'User', entityId: user._id });
          // TODO(Dev 5): notify the owner by email via the notification service (FRS F-03)
        }
      }
      throw unauthorized(LOGIN_FAILED);
    }
    if (!user.isActive) {
      await audit.record({ action: 'auth.login_blocked', entity: 'User', entityId: user._id, after: { reason: 'inactive' } });
      throw unauthorized(LOGIN_FAILED);
    }

    await User.updateOne({ _id: user._id }, { failedLogins: 0, lockUntil: null, lastLogin: new Date() });
    const s = await createSession(user, meta);
    await audit.record({ action: 'auth.login', entity: 'User', entityId: user._id });
    return { ...s, user };
  });
}

/** Everything the client needs to render the current user. Call inside tenant context. */
export async function describeUser(user) {
  const [role, tenant] = await Promise.all([
    Role.findById(user.roleId).lean(),
    runAsPlatform(async () => await Tenant.findById(user.tenantId).lean()),
  ]);
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    shopName: tenant?.name ?? '',
    tenant: tenant && { _id: tenant._id, name: tenant.name, status: tenant.status, currency: tenant.currency, timezone: tenant.timezone, trialEndsAt: tenant.trialEndsAt },
    role: role && { _id: role._id, key: role.key, name: role.name },
    permissions: role && { grid: role.grid, special: role.special, discountLimitPercent: user.discountLimit ?? role.discountLimitPercent },
    branchIds: user.branchIds,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };
}

export async function changePassword(userId, sessionId, currentPassword, newPassword) {
  const err = passwordError(newPassword);
  if (err) throw badRequest(err);
  const user = await User.findById(userId).select('+passwordHash');
  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw badRequest('Current password is incorrect');
  }
  await User.updateOne({ _id: userId }, { passwordHash: await hashPassword(newPassword) });
  await revokeUserSessions(userId, sessionId, 'password_changed');
  await audit.record({ action: 'auth.password_changed', entity: 'User', entityId: userId });
}

/** Store a single-use token on the user. Only the hash is persisted. */
export async function issueToken(userId, purpose, ttlMinutes) {
  const { token, hash } = newToken();
  await User.updateOne({ _id: userId }, { tokenHash: hash, tokenPurpose: purpose, tokenExpiresAt: new Date(Date.now() + ttlMinutes * 60_000) });
  return token;
}

export const setPasswordLink = (path, token) => `${config.clientUrl}/${path}?token=${token}`;

/** Forgot password. Always resolves quietly so the response cannot reveal whether the email exists. Returns the token (tests only). */
export async function forgotPassword(email) {
  const user = await runAsPlatform(async () => await User.findOne({ email, isActive: true }));
  if (!user) return null;
  return runWithContext({ tenantId: user.tenantId, userId: user._id }, async () => {
    const token = await issueToken(user._id, 'reset', 30);
    await audit.record({ action: 'auth.password_reset_requested', entity: 'User', entityId: user._id });
    // TODO(Dev 5): send by email through the notification service. Development only: log the link.
    if (config.env !== 'production') console.log(`[dev] password reset link for ${email}: ${setPasswordLink('reset-password', token)}`);
    return token;
  });
}

/** Consume an invite or reset token and set the password. Atomic: a token works exactly once. */
export async function consumeToken(token, purpose, newPassword) {
  const err = passwordError(newPassword);
  if (err) throw badRequest(err);
  if (typeof token !== 'string') throw badRequest('Invalid or expired link');
  const passwordHash = await hashPassword(newPassword);
  const user = await runAsPlatform(
    async () =>
      await User.findOneAndUpdate(
        { tokenHash: hashToken(token), tokenPurpose: purpose, tokenExpiresAt: { $gt: new Date() }, isActive: true },
        { passwordHash, failedLogins: 0, lockUntil: null, tokenHash: null, tokenPurpose: null, tokenExpiresAt: null }
      )
  );
  if (!user) throw badRequest('Invalid or expired link');
  await runWithContext({ tenantId: user.tenantId, userId: user._id }, async () => {
    await revokeUserSessions(user._id, null, 'password_reset');
    await audit.record({ action: purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', entity: 'User', entityId: user._id });
  });
}
