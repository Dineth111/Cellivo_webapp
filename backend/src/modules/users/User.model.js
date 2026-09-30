import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Full name is required'], trim: true, maxlength: [60, 'Name cannot exceed 60 characters'] },
    // Globally unique: login looks the user up by email before the tenant is known (FRS F-01).
    email: {
      type: String,
      required: [true, 'Email address is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address'],
    },
    passwordHash: { type: String, required: true, select: false },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    branchIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
      validate: [(v) => v.length > 0, 'At least one branch is required'],
    },
    phone: { type: String, default: '', trim: true },
    avatar: { type: String, default: '' },
    discountLimit: { type: Number, min: 0, max: 100, default: null }, // null = use the role's limit
    approvalPinHash: { type: String, select: false, default: null },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    // SRS SEC-10 lockout
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    // Single-use invite / password-reset token (only the hash is stored)
    tokenHash: { type: String, select: false, default: null },
    tokenPurpose: { type: String, enum: ['invite', 'reset', null], select: false, default: null },
    tokenExpiresAt: { type: Date, select: false, default: null },
  },
  { timestamps: true }
);
userSchema.plugin(tenantPlugin);
userSchema.index({ tokenHash: 1 }, { sparse: true });

// Never leak secrets even if a field was selected explicitly.
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    for (const k of ['passwordHash', 'approvalPinHash', 'tokenHash', 'tokenPurpose', 'tokenExpiresAt', 'failedLogins', 'lockUntil', '__v']) delete ret[k];
    return ret;
  },
});

export default mongoose.models.User || mongoose.model('User', userSchema);
