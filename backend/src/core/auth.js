import jwt from 'jsonwebtoken';
import Session from '../modules/auth/Session.model.js';
import User from '../modules/users/User.model.js';
import Tenant from '../modules/tenants/Tenant.model.js';
import Role from '../modules/roles/Role.model.js';
import { isIdle } from '../modules/auth/session.service.js';
import { runAsPlatform, runWithContext } from './tenantContext.js';
import { config } from './config.js';
import { unauthorized, wrap } from './errors.js';

const TOUCH_EVERY_MS = 60_000; // idle timeout has ~1 minute precision

/**
 * Authenticates the bearer token against its server-side session, then runs the rest of the
 * request inside the tenant context. Sets req.auth (the context) and req.user.
 */
export const protect = wrap(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized('Not authorized (token missing)');

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired authentication token', 'TOKEN_EXPIRED');
  }

  const loaded = await runAsPlatform(async () => {
    const session = await Session.findById(payload.sid);
    if (!session || session.revokedAt || String(session.userId) !== payload.uid) return null;
    const [user, tenant] = await Promise.all([User.findById(session.userId), Tenant.findById(session.tenantId)]);
    if (!user || !user.isActive || !tenant) return null;
    const role = await Role.findOne({ _id: user.roleId, tenantId: user.tenantId }).lean();
    return role ? { session, user, tenant, role } : null;
  });
  if (!loaded) throw unauthorized('Session is no longer valid. Please log in again.', 'SESSION_EXPIRED');

  const { session, user, tenant, role } = loaded;
  if (isIdle(session, tenant)) {
    await runAsPlatform(async () => await Session.updateOne({ _id: session._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'idle' }));
    throw unauthorized('Session expired due to inactivity. Please log in again.', 'SESSION_EXPIRED');
  }
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    runAsPlatform(async () => await Session.updateOne({ _id: session._id }, { lastSeenAt: new Date() })).catch(() => {});
  }

  const ctx = {
    tenantId: user.tenantId,
    userId: user._id,
    sessionId: session._id,
    role,
    branchIds: user.branchIds,
    discountLimit: user.discountLimit ?? role.discountLimitPercent,
    tenantStatus: tenant.status, // TODO(Dev 2): suspended tenants may only reach billing
    ip: req.ip,
    device: req.get('user-agent') || '',
  };
  req.auth = ctx;
  req.user = user;
  req.tenant = tenant;
  runWithContext(ctx, next);
});
