import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    invoicePrefix: { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
    address: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
branchSchema.plugin(tenantPlugin);
branchSchema.index({ tenantId: 1, invoicePrefix: 1 }, { unique: true });

export default mongoose.models.Branch || mongoose.model('Branch', branchSchema);
