import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const supplierBillSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    billNumber: { type: String, required: true, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceivedNote', default: null, index: true },
    grnNumber: { type: String, trim: true, default: '' },
    totalAmountCents: { type: Number, required: true, min: 0 },
    paidAmountCents: { type: Number, default: 0, min: 0 },
    balanceCents: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['unpaid', 'partially_paid', 'paid', 'voided'],
      default: 'unpaid',
      index: true,
    },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

supplierBillSchema.plugin(tenantPlugin);
supplierBillSchema.index({ tenantId: 1, billNumber: 1 }, { unique: true });
supplierBillSchema.index({ tenantId: 1, supplierId: 1, status: 1 });
supplierBillSchema.index({ tenantId: 1, dueDate: 1 });

export default mongoose.models.SupplierBill || mongoose.model('SupplierBill', supplierBillSchema);
