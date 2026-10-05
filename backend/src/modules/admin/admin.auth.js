import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { AdminUser, AdminSession, platformAudit } from './admin.models.js';
import { config } from '../../core/config.js';
import { verifyPassword } from '../../core/password.js';
import { unauthorized, forbidden, wrap } from '../../core/errors.js';

// Platform admin login (FRS section 4): password, then a mandatory TOTP code. Separate from tenant
// users and sessions. Admin tokens carry aud "admin" so the tenant `protect` can never accept them.

const ADMIN_IDLE_MS = 30 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30s) with the standard library ------------------------
export const newTotpSecret = () => {
  let bits = '';
  for (const b of crypto.randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g).map((c) => B32[parseInt(c, 2)]).join('');
};

const b32decode = (s) => {
  const bits = [...s].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
};

export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

/** Accepts the previous, current and next 30s window (clock drift). */
export const totpValid = (secret, code, at = Date.now()) =>
  /^\d{6}$/.test(String(code)) && [-1, 0, 1].some((w) => crypto.timingSafeEqual(Buffer.from(totp(secret, at + w * 30_000)), Buffer.from(String(code))));

export const otpauthUrl = (email, secret) => `otpauth://totp/Cellivo%20Admin:${encodeURIComponent(email)}?secret=${secret}&issuer=Cellivo%20Admin`;

// ---- tokens ----------------------------------------------------------------------------------
const sign = (payload, expiresIn) => jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256', audience: 'admin', expiresIn });
const verify = (token, purpose) => {
  let p;
  try { p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'admin' }); } catch { throw unauthorized('Invalid or expired token', 'TOKEN_EXPIRED'); }
  if (p.purpose !== purpose) throw unauthorized('Invalid or expired token', 'TOKEN_EXPIRED');
  return p;
};

export const ipAllowed = (ip, admin) => {
  const list = [...config.adminIpAllowList, ...(admin?.ipAllowList || [])];
  return list.length === 0 || list.includes(ip) || list.includes(ip?.replace(/^::ffff:/, ''));
};

// ---- login flow ------------------------------------------------------------------------------
/** Step 1: email + password. Returns a 5 minute challenge for step 2 (never a session). */
export async function login(email, password, ip) {
  const admin = await AdminUser.findOne({ email: String(email || '').toLowerCase() }).select('+passwordHash +failedLogins +lockUntil +totpSecret');
  const bad = unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  if (!admin || !admin.isActive) throw bad;
  if (admin.lockUntil && admin.lockUntil > new Date()) throw unauthorized('Too many failed attempts. Try again in 15 minutes.', 'LOCKED');
  if (!ipAllowed(ip, admin)) {
    await platformAudit({ admin, action: 'admin.login_blocked_ip', entity: 'AdminUser', entityId: admin._id, ip });
    throw forbidden('Admin access is not allowed from this network', 'IP_BLOCKED');
  }
  if (typeof password !== 'string' || !(await verifyPassword(password, admin.passwordHash))) {
    admin.failedLogins = (admin.failedLogins || 0) + 1;
    if (admin.failedLogins >= MAX_FAILS) { admin.lockUntil = new Date(Date.now() + LOCK_MS); admin.failedLogins = 0; }
    await admin.save();
    throw bad;
  }
  return { challenge: sign({ purpose: 'mfa', aid: String(admin._id) }, '5m'), twoFactorEnrolled: admin.totpEnabled };
}

/** First login only: create (not yet enable) the TOTP secret and return it for the authenticator app. */
export async function enroll(challenge) {
  const { aid } = verify(challenge, 'mfa');
  const admin = await AdminUser.findById(aid).select('+totpSecret');
  if (!admin || !admin.isActive) throw unauthorized('Invalid or expired token');
  if (admin.totpEnabled) throw forbidden('Two-factor authentication is already set up', 'ALREADY_ENROLLED');
  admin.totpSecret = newTotpSecret();
  await admin.save();
  return { secret: admin.totpSecret, otpauthUrl: otpauthUrl(admin.email, admin.totpSecret) };
}

/** Step 2: the 6 digit code. On success (and the first success enables 2FA) a session is created. */
export async function verifyCode(challenge, code, { ip = '', device = '' } = {}) {
  const { aid } = verify(challenge, 'mfa');
  const admin = await AdminUser.findById(aid).select('+totpSecret +failedLogins +lockUntil');
  if (!admin || !admin.isActive || !admin.totpSecret) throw unauthorized('Invalid or expired token');
  if (admin.lockUntil && admin.lockUntil > new Date()) throw unauthorized('Too many failed attempts. Try again in 15 minutes.', 'LOCKED');
  if (!totpValid(admin.totpSecret, code)) {
    admin.failedLogins = (admin.failedLogins || 0) + 1;
    if (admin.failedLogins >= MAX_FAILS) { admin.lockUntil = new Date(Date.now() + LOCK_MS); admin.failedLogins = 0; }
    await admin.save();
    throw unauthorized('That code is not correct', 'INVALID_CODE');
  }
  admin.totpEnabled = true;
  admin.failedLogins = 0;
  admin.lockUntil = null;
  admin.lastLogin = new Date();
  await admin.save();
  const session = await AdminSession.create({ adminId: admin._id, ip, device: device.slice(0, 200) });
  await platformAudit({ admin, action: 'admin.login', entity: 'AdminUser', entityId: admin._id, ip });
  return { token: sign({ purpose: 'session', aid: String(admin._id), asid: String(session._id) }, '12h'), admin: publicAdmin(admin) };
}

export const publicAdmin = (a) => ({ id: a._id, name: a.name, email: a.email, role: a.role, totpEnabled: a.totpEnabled });

// ---- middleware ------------------------------------------------------------------------------
/** Authenticates an admin session (and re-checks the IP list on every call). Sets req.admin. */
export const adminProtect = wrap(async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw unauthorized('Not authorized (token missing)');
  const p = verify(header.slice(7), 'session');
  const session = await AdminSession.findById(p.asid);
  if (!session || session.revokedAt || String(session.adminId) !== p.aid) throw unauthorized('Session is no longer valid. Please log in again.', 'SESSION_EXPIRED');
  if (Date.now() - session.lastSeenAt.getTime() > ADMIN_IDLE_MS) {
    await AdminSession.updateOne({ _id: session._id }, { revokedAt: new Date() });
    throw unauthorized('Session expired due to inactivity. Please log in again.', 'SESSION_EXPIRED');
  }
  const admin = await AdminUser.findById(p.aid);
  if (!admin || !admin.isActive) throw unauthorized('Session is no longer valid. Please log in again.', 'SESSION_EXPIRED');
  if (!ipAllowed(req.ip, admin)) throw forbidden('Admin access is not allowed from this network', 'IP_BLOCKED');
  await AdminSession.updateOne({ _id: session._id }, { lastSeenAt: new Date() });
  req.admin = admin;
  req.adminSession = session;
  next();
});

/** super_admin always passes; otherwise the role must be listed. */
export const needs = (...roles) => (req, res, next) =>
  req.admin.role === 'super_admin' || roles.includes(req.admin.role) ? next() : next(forbidden('Your admin role cannot do this'));
