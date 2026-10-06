// TEMP: replace with Developer 1's service (POST /api/users/verify-pin)
import bcrypt from 'bcryptjs';
import User from '../../users/User.model.js';
import { runAsPlatform } from '../../../core/tenantContext.js';
import { hasSpecial } from '../../../core/permissions.js';
import Role from '../../roles/Role.model.js';

/**
 * Verifies if a given manager PIN is valid for a tenant user who has permission to approve discounts.
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @param {string} pin
 * @returns {Promise<{ approved: boolean, approver?: object }>}
 */
export async function verifyApprovalPin(tenantId, pin) {
  if (!pin) return { approved: false };

  return await runAsPlatform(async () => {
    // Find all active users for this tenant that have an approval PIN hash set
    const users = await User.find({
      tenantId,
      isActive: true,
      approvalPinHash: { $ne: null },
    })
      .select('+approvalPinHash')
      .populate('roleId');

    for (const u of users) {
      const isMatch = await bcrypt.compare(String(pin), u.approvalPinHash);
      if (isMatch) {
        const role = u.roleId;
        // Verify user has discount approval rights (owner or approve_discount special permission)
        if (role && (role.key === 'owner' || hasSpecial(role, 'approve_discount') || role.key === 'branch_manager')) {
          return { approved: true, approver: u };
        }
      }
    }

    return { approved: false };
  });
}

export default { verifyApprovalPin };
