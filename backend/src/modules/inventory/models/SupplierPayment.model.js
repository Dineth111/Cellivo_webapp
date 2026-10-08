import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const supplierPaymentSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    paymentNumber: { type: String, required: true, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierBill', default: null, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer', 'cheque'],
      required: true,
    },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

supplierPaymentSchema.plugin(tenantPlugin);
supplierPaymentSchema.index({ tenantId: 1, paymentNumber: 1 }, { unique: true });
supplierPaymentSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });

export default mongoose.models.SupplierPayment || mongoose.model('SupplierPayment', supplierPaymentSchema);
