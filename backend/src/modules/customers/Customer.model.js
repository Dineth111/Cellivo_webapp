import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

// SRS CRM-01. Features (history, credit, loyalty) belong to Dev 5; this is only the tenant-scoped base.
const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Customer name is required'], trim: true, maxlength: 100 },
    phone: { type: String, required: [true, 'Phone number is required'], trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, default: '', maxlength: 254 },
    address: { type: String, trim: true, default: '', maxlength: 300 },
    nic: { type: String, trim: true, default: '', maxlength: 20 },
    type: { type: String, enum: ['retail', 'wholesale'], default: 'retail' },
    creditLimitCents: { type: Number, default: 0, min: 0 },
    currentBalanceCents: { type: Number, default: 0, min: 0 },
    loyaltyPoints: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', maxlength: 2000 },
    tags: {
      type: [{ type: String, trim: true, maxlength: 50 }],
      default: [],
      validate: [(v) => Array.isArray(v) && v.length <= 20, 'Tags cannot exceed 20 items'],
    },
    marketingOptIn: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  },
  { timestamps: true }
);
customerSchema.plugin(tenantPlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true }); // FRS F-13: phone unique within tenant
customerSchema.index({ tenantId: 1, isArchived: 1, createdAt: -1 });
customerSchema.index({ tenantId: 1, email: 1 });
customerSchema.index({ tenantId: 1, nic: 1 });

export default mongoose.models.Customer || mongoose.model('Customer', customerSchema);
