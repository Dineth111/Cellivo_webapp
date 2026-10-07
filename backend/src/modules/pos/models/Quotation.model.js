import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const quotationSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    quoteNumber: { type: String, required: true, trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    lines: { type: [mongoose.Schema.Types.Mixed], default: [] },
    subtotalCents: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, default: 0, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    grandTotalCents: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['active', 'converted', 'expired'],
      default: 'active',
      index: true,
    },
    convertedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'PosInvoice', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    validUntil: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days default validity
    },
  },
  { timestamps: true }
);

quotationSchema.plugin(tenantPlugin);
quotationSchema.index({ tenantId: 1, quoteNumber: 1 }, { unique: true });
quotationSchema.index({ tenantId: 1, branchId: 1, status: 1 });

export default mongoose.models.Quotation || mongoose.model('Quotation', quotationSchema);
