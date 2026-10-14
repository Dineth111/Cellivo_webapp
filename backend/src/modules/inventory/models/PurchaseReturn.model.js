import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const purchaseReturnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    barcode: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    unitCostCents: { type: Number, required: true, min: 0 },
    totalCostCents: { type: Number, required: true, min: 0 },
    imeis: { type: [String], default: [] },
    reason: { type: String, default: '', trim: true },
  },
  { _id: true }
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    returnNumber: { type: String, required: true, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceivedNote', default: null, index: true },
    items: { type: [purchaseReturnItemSchema], default: [] },
    totalAmountCents: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['completed', 'voided'], default: 'completed', index: true },
    notes: { type: String, default: '', trim: true },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

purchaseReturnSchema.plugin(tenantPlugin);
purchaseReturnSchema.index({ tenantId: 1, returnNumber: 1 }, { unique: true });
purchaseReturnSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });

export default mongoose.models.PurchaseReturn || mongoose.model('PurchaseReturn', purchaseReturnSchema);
