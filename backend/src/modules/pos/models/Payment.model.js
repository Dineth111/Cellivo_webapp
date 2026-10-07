import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const paymentSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'PosInvoice', required: true, index: true },
    method: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer', 'cheque', 'credit', 'store_credit', 'loyalty_points'],
      required: true,
    },
    amountCents: { type: Number, required: true, min: 0 },
    reference: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['paid', 'pending', 'bounced', 'voided'],
      default: 'paid',
      index: true,
    },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ tenantId: 1, invoiceId: 1 });
paymentSchema.index({ tenantId: 1, branchId: 1, method: 1 });

export default mongoose.models.PosPayment || mongoose.model('PosPayment', paymentSchema, 'pos_payments');
