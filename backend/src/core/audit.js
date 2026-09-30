import AuditLog from '../modules/audit/AuditLog.model.js';
import { getContext, runWithContext } from './tenantContext.js';

const SENSITIVE = new Set(['password', 'passwordHash', 'approvalPin', 'approvalPinHash', 'tokenHash', 'refreshToken', 'refreshTokenHash', 'token']);
const redact = (v) => (v == null ? null : JSON.parse(JSON.stringify(v, (k, val) => (SENSITIVE.has(k) ? undefined : val))));

/**
 * Append an audit entry. tenantId / userId / ip / device default to the current request context.
 * Never throws: a failing audit write must not break the user's action (it is logged loudly instead).
 *
 *   await audit.record({ action: 'user.update', entity: 'User', entityId: u._id, before, after });
 */
export async function record({ action, entity = '', entityId = '', before, after, tenantId, userId, ip, device }) {
  try {
    const ctx = getContext() || {};
    const tid = tenantId ?? ctx.tenantId;
    if (!tid) return console.warn(`[audit] skipped "${action}": no tenant`);
    await runWithContext({ tenantId: tid }, async () =>
      AuditLog.create({
        userId: userId ?? ctx.userId ?? null,
        action,
        entity,
        entityId: String(entityId ?? ''),
        before: redact(before),
        after: redact(after),
        ip: ip ?? ctx.ip ?? '',
        device: device ?? ctx.device ?? '',
      })
    );
  } catch (err) {
    console.error(`[audit] FAILED to record "${action}":`, err.message);
  }
}

export default { record };
