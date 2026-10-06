import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

// SRS CRM-01. Features (history, credit, loyalty) belong to Dev 5; this is only the tenant-scoped base.
const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Customer name is required'], trim: true, maxlength: 100 },
    phone: { type: String, required: [true, 'Phone number is required'], trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    nic: { type: String, trim: true, default: '' },
    type: { type: String, enum: ['retail', 'wholesale'], default: 'retail' },
    creditLimitCents: { type: Number, default: 0, min: 0 },
    currentBalanceCents: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);
customerSchema.plugin(tenantPlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true }); // FRS F-13: phone unique within tenant

export default mongoose.models.Customer || mongoose.model('Customer', customerSchema);
