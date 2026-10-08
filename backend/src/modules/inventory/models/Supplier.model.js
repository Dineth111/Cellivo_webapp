import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Supplier name is required'], trim: true, maxlength: 100 },
    contactPerson: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    paymentTermsDays: { type: Number, default: 30, min: 0 },
    openingBalanceCents: { type: Number, default: 0 },
    currentBalanceCents: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    isArchived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

supplierSchema.plugin(tenantPlugin);
supplierSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.models.Supplier || mongoose.model('Supplier', supplierSchema);
