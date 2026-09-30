import jwt from 'jsonwebtoken';
import Session from './Session.model.js';
import User from '../users/User.model.js';
import Tenant from '../tenants/Tenant.model.js';
import { runAsPlatform, runWithContext } from '../../core/tenantContext.js';
import { newToken, hashToken } from '../../core/password.js';
import { config } from '../../core/config.js';
import { unauthorized } from '../../core/errors.js';
import audit from '../../core/audit.js';

export const signAccessToken = (session) =>
  jwt.sign({ sid: String(session._id), uid: String(session.userId), tid: String(session.tenantId) }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.accessTokenTtl,
  });

export const isIdle = (session, tenant) => Date.now() - session.lastSeenAt.getTime() > (tenant?.idleTimeoutMinutes ?? 30) * 60_000;

/** Create a session for a user. Call inside runWithContext({ tenantId }). */
export async function createSession(user, { ip = '', device = '' } = {}) {
  const refresh = newToken();
  const session = await Session.create({ userId: user._id, ip, device: device.slice(0, 200), refreshTokenHash: refresh.hash });
  return { session, token: signAccessToken(session), refreshToken: refresh.token };
}

/** Exchange a refresh token for a new access token; the refresh token rotates. Unauthenticated route. */
export async function refreshSession(refreshToken) {
  if (typeof refreshToken !== 'string') throw unauthorized('Invalid refresh token');
  const oldHash = hashToken(refreshToken);
  const found = await runAsPlatform(async () => {
    const s = await Session.findOne({ refreshTokenHash: oldHash });
    if (!s || s.revokedAt) return null;
    const [user, tenant] = await Promise.all([User.findById(s.userId), Tenant.findById(s.tenantId)]);
    return { s, user, tenant };
  });
  if (!found?.user?.isActive) throw unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');

  return runWithContext({ tenantId: found.s.tenantId, userId: found.user._id }, async () => {
    if (isIdle(found.s, found.tenant)) {
      await revokeSession(found.s._id, 'idle');
      throw unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');
    }
    const next = newToken();
    // atomic rotation: a replayed old refresh token matches nothing
    const s = await Session.findOneAndUpdate(
      { _id: found.s._id, refreshTokenHash: oldHash, revokedAt: null },
      { refreshTokenHash: next.hash, lastSeenAt: new Date() },
      { new: true }
    );
    if (!s) throw unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');
    return { token: signAccessToken(s), refreshToken: next.token };
  });
}

/** Revoke one session (tenant context). Returns true if it was active. */
export async function revokeSession(sessionId, reason = 'logout') {
  const s = await Session.findOneAndUpdate({ _id: sessionId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
  if (s) await audit.record({ action: reason === 'idle' ? 'auth.session_expired' : 'auth.session_revoked', entity: 'Session', entityId: s._id, userId: s.userId });
  return !!s;
}

/** Revoke all of a user's sessions, optionally keeping one (tenant context). */
export const revokeUserSessions = (userId, exceptSessionId, reason) =>
  Session.updateMany({ userId, revokedAt: null, ...(exceptSessionId && { _id: { $ne: exceptSessionId } }) }, { revokedAt: new Date(), revokedReason: reason });
