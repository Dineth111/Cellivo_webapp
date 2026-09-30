import mongoose from 'mongoose';

export const TENANT_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled', 'archived'];

// Platform-level record (not tenant-scoped itself). Billing fields are owned by the billing module (Dev 2).
const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    country: { type: String, default: 'LK', trim: true, uppercase: true },
    currency: { type: String, default: 'LKR' },
    timezone: { type: String, default: 'Asia/Colombo' },
    status: { type: String, enum: TENANT_STATUSES, default: 'trial' },
    trialEndsAt: { type: Date, default: null },
    idleTimeoutMinutes: { type: Number, default: 30, min: 10, max: 240 },
  },
  { timestamps: true }
);

export default mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
