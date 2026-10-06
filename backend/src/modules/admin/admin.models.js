import mongoose from 'mongoose';

const { Schema } = mongoose;
const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });

// FRS 4.1: fixed admin roles
export const ADMIN_ROLES = ['super_admin', 'support', 'sales', 'finance', 'content'];

// Platform staff. Completely separate from tenant users: no tenantId, own login, own sessions (ADM-26).
const adminUserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ADMIN_ROLES, required: true },
    totpSecret: { type: String, default: null, select: false }, // base32; 2FA is mandatory (ADM-26)
    totpEnabled: { type: Boolean, default: false },
    ipAllowList: { type: [String], default: [] }, // extra per-user IPs, on top of ADMIN_IP_ALLOWLIST
    isActive: { type: Boolean, default: true },
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLogin: Date,
  },
  { timestamps: true }
);
export const AdminUser = mongoose.models.AdminUser || mongoose.model('AdminUser', adminUserSchema);

const adminSessionSchema = new Schema(
  {
    adminId: { ...oid('AdminUser'), required: true, index: true },
    ip: String,
    device: String,
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const AdminSession = mongoose.models.AdminSession || mongoose.model('AdminSession', adminSessionSchema);

// Platform audit log (ADM-27): every admin action, plus system events (billing job). Append-only.
const auditSchema = new Schema(
  {
    actor: { kind: { type: String, enum: ['admin', 'system', 'tenant'], default: 'admin' }, id: oid('AdminUser'), name: String },
    action: { type: String, required: true, index: true },
    entity: String,
    entityId: String,
    tenantId: { ...oid('Tenant'), index: true },
    reason: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: 'at', updatedAt: false } }
);
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditSchema.pre(op, () => { throw new Error('The platform audit log is append-only'); });
}
export const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', auditSchema);

/** Record a platform action. Never throws, so it cannot break the action it describes. */
export async function platformAudit({ admin, action, entity, entityId, tenantId, reason, before, after, ip }) {
  try {
    await AdminAudit.create({
      actor: admin ? { kind: 'admin', id: admin._id, name: admin.email } : { kind: 'system', name: 'system' },
      action, entity, entityId: entityId && String(entityId), tenantId, reason, before, after, ip,
    });
  } catch (e) {
    console.error('[platform audit]', e.message);
  }
}
