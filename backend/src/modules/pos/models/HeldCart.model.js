import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const heldCartSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    cartName: { type: String, default: 'Held Cart', trim: true },
    customer: { type: mongoose.Schema.Types.Mixed, default: null },
    lines: { type: [mongoose.Schema.Types.Mixed], default: [] },
    discounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from hold
      index: true,
    },
  },
  { timestamps: true }
);

heldCartSchema.plugin(tenantPlugin);
heldCartSchema.index({ tenantId: 1, branchId: 1, expiresAt: 1 });

export default mongoose.models.HeldCart || mongoose.model('HeldCart', heldCartSchema);
