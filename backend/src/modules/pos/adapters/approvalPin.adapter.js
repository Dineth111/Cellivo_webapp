import { verifyApprovalPin as verify } from '../../users/users.service.js';

/**
 * Verifies a manager approval PIN typed in by the requesting user, through the users service
 * (owner or approve_discount approvers; 5 wrong PINs in 15 minutes -> 429 PIN_LOCKED, stored on the user).
 *
 * @param {string|import('mongoose').Types.ObjectId} tenantId
 * @param {string} pin
 * @param {string|import('mongoose').Types.ObjectId|null} userId the user asking for approval
 * @returns {Promise<{ approved: boolean, approver?: { _id: import('mongoose').Types.ObjectId } }>}
 */
export async function verifyApprovalPin(tenantId, pin, userId = null) {
  const result = await verify({ tenantId, requestedBy: userId, pin });
  return result ? { approved: true, approver: { _id: result.approverId } } : { approved: false };
}

export default { verifyApprovalPin };
