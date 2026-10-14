import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const PO_STATUSES = ['draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled'];

const poItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    barcode: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    unitCostCents: { type: Number, required: true, min: 0 },
    totalCostCents: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    poNumber: { type: String, required: true, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    status: { type: String, enum: PO_STATUSES, default: 'draft', index: true },
    items: { type: [poItemSchema], default: [] },
    subtotalCents: { type: Number, default: 0, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    totalCents: { type: Number, default: 0, min: 0 },
    expectedDate: { type: Date, default: null },
    notes: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

purchaseOrderSchema.plugin(tenantPlugin);
purchaseOrderSchema.index({ tenantId: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });

export default mongoose.models.PurchaseOrder || mongoose.model('PurchaseOrder', purchaseOrderSchema);
