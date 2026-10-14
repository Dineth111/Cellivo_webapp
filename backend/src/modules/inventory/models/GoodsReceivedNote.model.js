import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const grnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    barcode: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    unitCostCents: { type: Number, required: true, min: 0 },
    totalCostCents: { type: Number, required: true, min: 0 },
    imeis: { type: [String], default: [] },
  },
  { _id: true }
);

const grnSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    grnNumber: { type: String, required: true, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null, index: true },
    paymentType: {
      type: String,
      enum: ['credit', 'cash', 'card', 'bank_transfer', 'cheque'],
      default: 'credit',
      required: true,
    },
    items: { type: [grnItemSchema], default: [] },
    totalAmountCents: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['posted', 'voided'], default: 'posted', index: true },
    notes: { type: String, default: '', trim: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

grnSchema.plugin(tenantPlugin);
grnSchema.index({ tenantId: 1, grnNumber: 1 }, { unique: true });
grnSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });

export default mongoose.models.GoodsReceivedNote || mongoose.model('GoodsReceivedNote', grnSchema);
