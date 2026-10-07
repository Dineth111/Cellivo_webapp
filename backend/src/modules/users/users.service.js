import User from './User.model.js';
import Role from '../roles/Role.model.js';
import Branch from '../branches/Branch.model.js';
import { getContext, runAsPlatform } from '../../core/tenantContext.js';
import { hashPassword, newToken, verifyPassword } from '../../core/password.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { SPECIALS } from '../../core/permissions.js';
import { str, isId, requireId } from '../../core/validate.js';
import { config } from '../../core/config.js';
import audit from '../../core/audit.js';
import { setPasswordLink, issueToken } from '../auth/auth.service.js';
import { revokeUserSessions } from '../auth/session.service.js';
import { assertCanAddUser, tenantFromContext } from '../plans/planLimits.js';

const isOwnerCtx = () => getContext().role.key === 'owner';

async function checkRole(roleId) {
  requireId(roleId, 'role id');
  const role = await Role.findById(roleId);
  if (!role) throw badRequest('Role not found');
  if (role.key === 'owner' && !isOwnerCtx()) throw forbidden('Only an owner can assign the Owner role');
  return role;
}

async function checkBranches(ids) {
  if (!Array.isArray(ids) || !ids.length || !ids.every(isId)) throw badRequest('Select at least one branch');
  const unique = [...new Set(ids)];
  if ((await Branch.countDocuments({ _id: { $in: unique }, isActive: true })) !== unique.length) throw badRequest('Unknown branch');
  return unique;
}

function parseLimit(v) {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('Discount limit must be between 0 and 100');
  return n;
}

async function pinHash(pin) {
  if (!/^\d{4,6}$/.test(String(pin))) throw badRequest('Approval PIN must be 4 to 6 digits');
  return hashPassword(String(pin));
}

/** A tenant must always keep at least one active owner. Throws if `userId` is the last one. */
async function assertNotLastOwner(userId) {
  const ownerRole = await Role.findOne({ key: 'owner' });
  const others = await User.countDocuments({ roleId: ownerRole._id, isActive: true, _id: { $ne: userId } });
  if (others === 0) throw conflict('A shop must always have at least one active owner', 'LAST_OWNER');
}

async function load(id) {
  requireId(id, 'user id');
  const user = await User.findById(id).populate('roleId', 'name key');
  if (!user) throw notFound('User not found');
  return user;
}

const isOwnerUser = (u) => u.roleId?.key === 'owner';

export async function inviteUser(b = {}) {
  const email = str(b.email)?.toLowerCase();
  const name = str(b.name);
  if (!name || !email) throw badRequest('Name and email are required');
  const role = await checkRole(b.roleId);
  await assertCanAddUser(await tenantFromContext(), role.key); // plan user/role limits (FRS F-04)
  const branchIds = await checkBranches(b.branchIds);
  const data = { name, email, phone: str(b.phone) || '', roleId: role._id, branchIds };
  if (b.discountLimit !== undefined) data.discountLimit = parseLimit(b.discountLimit);
  if (b.approvalPin !== undefined) data.approvalPinHash = await pinHash(b.approvalPin);
  // random unusable password until the invitation is accepted
  data.passwordHash = await hashPassword(newToken().token);
  const user = await User.create(data);
  const token = await issueToken(user._id, 'invite', 48 * 60);
  await audit.record({ action: 'user.create', entity: 'User', entityId: user._id, after: user });
  // TODO(Dev 5): email/SMS the invitation via the notification service. Development only: log the link.
  if (config.env !== 'production') console.log(`[dev] invitation link for ${email}: ${setPasswordLink('set-password', token)}`);
  return { user, token };
}

export async function updateUser(id, b = {}) {
  const user = await load(id);
  if (isOwnerUser(user) && !isOwnerCtx()) throw forbidden('Only an owner can change an owner');
  const before = user.toObject();
  if (str(b.name)) user.name = str(b.name);
  if (str(b.phone) !== undefined) user.phone = str(b.phone);
  if (b.roleId !== undefined && String(b.roleId) !== String(user.roleId._id)) {
    const role = await checkRole(b.roleId);
    if (isOwnerUser(user) && role.key !== 'owner' && user.isActive) await assertNotLastOwner(user._id);
    user.roleId = role._id;
  }
  if (b.branchIds !== undefined) user.branchIds = await checkBranches(b.branchIds);
  if (b.discountLimit !== undefined) user.discountLimit = parseLimit(b.discountLimit);
  if (b.approvalPin !== undefined) user.approvalPinHash = await pinHash(b.approvalPin);
  await user.save();
  await audit.record({ action: 'user.update', entity: 'User', entityId: user._id, before, after: user });
  return user;
}

export async function setActive(id, active) {
  const user = await load(id);
  if (isOwnerUser(user) && !isOwnerCtx()) throw forbidden('Only an owner can change an owner');
  if (!active && isOwnerUser(user) && user.isActive) await assertNotLastOwner(user._id);
  user.isActive = active;
  await user.save();
  if (!active) await revokeUserSessions(user._id, null, 'deactivated');
  await audit.record({ action: active ? 'user.activate' : 'user.deactivate', entity: 'User', entityId: user._id });
  return user;
}

export const getUser = load;

const PIN_MAX_FAILURES = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // failure window and lock length
const pinLocked = () => new AppError(429, 'Too many wrong approval PINs. Try again in 15 minutes.', 'PIN_LOCKED');

/**
 * Checks an approval PIN typed in by `requestedBy`. Approvers are active users of the tenant with a PIN
 * whose role is owner or has `special`. 5 wrong PINs in 15 minutes lock the requesting user for 15
 * minutes (stored on the user, so it survives restarts and is shared between instances).
 * Returns { approverId }, or null for a wrong or empty PIN. Throws 429 PIN_LOCKED while locked.
 */
export async function verifyApprovalPin({ tenantId, requestedBy, pin, special = 'approve_discount' }) {
  if (!SPECIALS.includes(special)) throw badRequest('Unknown approval permission');
  const { ip, device } = getContext() || {}; // runAsPlatform drops the request context; keep these for the audit
  return runAsPlatform(async () => {
    const now = new Date();
    // ponytail: check-then-compare, so requests already in flight when the lock lands still get compared
    if (await User.exists({ _id: requestedBy, tenantId, pinLockedUntil: { $gt: now } })) throw pinLocked();
    if (!pin) return null;

    const roles = await Role.find({ tenantId, $or: [{ key: 'owner' }, { [`special.${special}`]: true }] }).select('_id').lean();
    const approvers = await User.find({
      tenantId,
      isActive: true,
      approvalPinHash: { $ne: null },
      roleId: { $in: roles.map((r) => r._id) },
    }).select('+approvalPinHash');
    for (const u of approvers) {
      if (await verifyPassword(String(pin), u.approvalPinHash)) {
        await User.updateOne({ _id: requestedBy, tenantId }, { pinFailedAttempts: 0, pinFailedSince: null, pinLockedUntil: null });
        return { approverId: u._id };
      }
    }

    // One atomic update: count the failure in the current window (or start a new one), lock at the limit.
    const inWindow = { $gte: [{ $ifNull: ['$pinFailedSince', new Date(0)] }, new Date(now - PIN_WINDOW_MS)] };
    const user = await User.findOneAndUpdate(
      { _id: requestedBy, tenantId },
      [
        {
          $set: {
            pinFailedAttempts: { $cond: [inWindow, { $add: [{ $ifNull: ['$pinFailedAttempts', 0] }, 1] }, 1] },
            pinFailedSince: { $cond: [inWindow, '$pinFailedSince', now] },
          },
        },
        { $set: { pinLockedUntil: { $cond: [{ $gte: ['$pinFailedAttempts', PIN_MAX_FAILURES] }, new Date(+now + PIN_WINDOW_MS), '$pinLockedUntil'] } } },
      ],
      { new: true, projection: { pinFailedAttempts: 1, pinLockedUntil: 1 } }
    ).lean();
    const attempts = user?.pinFailedAttempts ?? 0;
    const auditBase = { entity: 'User', entityId: requestedBy, tenantId, userId: requestedBy, ip, device };
    await audit.record({ ...auditBase, action: 'pin.verify_failed', after: { special, failuresInWindow: attempts } });
    if (attempts === PIN_MAX_FAILURES) await audit.record({ ...auditBase, action: 'pin.locked', after: { lockedUntil: user.pinLockedUntil } });
    return null;
  });
}
