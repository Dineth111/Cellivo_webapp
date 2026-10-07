// TEMP: replace with Developer 1's service (POST /api/users/verify-pin)
import bcrypt from 'bcryptjs';
import User from '../../users/User.model.js';
import Role from '../../roles/Role.model.js';
import { runAsPlatform } from '../../../core/tenantContext.js';
import { AppError } from '../../../core/errors.js';
import * as auditAdapter from './audit.adapter.js';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
// ponytail: in-memory, per process; move to Mongo/Redis if the API runs on more than one instance
const failures = new Map(); // `${tenantId}:${userId}` -> timestamps of recent failures

const recentFailures = (key) => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW_MS);

/**
 * Verifies a manager approval PIN typed in by the requesting user.
 * Only users who can approve (owner, or a role with approve_discount) are compared.
 * 5 wrong PINs in 15 minutes lock that requesting user out of PIN approvals (429 PIN_LOCKED).
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @param {string} pin
 * @param {string|import('mongoose').Types.ObjectId|null} userId the user asking for approval
 * @returns {Promise<{ approved: boolean, approver?: object }>}
 */
export async function verifyApprovalPin(tenantId, pin, userId = null) {
  if (!pin) return { approved: false };

  const key = `${tenantId}:${userId || 'unknown'}`;
  const recent = recentFailures(key);
  if (recent.length >= MAX_FAILURES) {
    throw new AppError(429, 'Too many wrong approval PINs. Try again in 15 minutes.', 'PIN_LOCKED');
  }

  const approver = await runAsPlatform(async () => {
    const roles = await Role.find({ tenantId, $or: [{ key: 'owner' }, { 'special.approve_discount': true }] }).select('_id').lean();
    const users = await User.find({
      tenantId,
      isActive: true,
      approvalPinHash: { $ne: null },
      roleId: { $in: roles.map((r) => r._id) },
    }).select('+approvalPinHash');

    for (const u of users) {
      if (await bcrypt.compare(String(pin), u.approvalPinHash)) return u;
    }
    return null;
  });

  if (approver) {
    failures.delete(key);
    return { approved: true, approver };
  }

  failures.set(key, [...recent, Date.now()]);
  await auditAdapter.record({
    action: 'pos.approval_pin_failed',
    entity: 'User',
    entityId: userId || '',
    after: { failuresInWindow: recent.length + 1 },
    tenantId,
    userId,
  });
  return { approved: false };
}

export default { verifyApprovalPin };
