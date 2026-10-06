// TEMP: replace with Developer 1's service
import audit from '../../../core/audit.js';

/**
 * Audit recording adapter for POS transactions and overrides.
 *
 * @param {{ action: string, entity?: string, entityId?: string|object, before?: any, after?: any, reason?: string, tenantId?: any, userId?: any }} params
 */
export async function record({ action, entity = '', entityId = '', before = null, after = null, reason = null, tenantId, userId }) {
  const enrichedAfter = reason != null
    ? (typeof after === 'object' && after !== null ? { ...after, reason } : { data: after, reason })
    : after;

  return await audit.record({
    action,
    entity,
    entityId: String(entityId || ''),
    before,
    after: enrichedAfter,
    tenantId,
    userId,
  });
}

export default { record };
