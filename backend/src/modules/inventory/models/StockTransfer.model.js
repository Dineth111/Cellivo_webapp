import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'dispatched',
  'partially_received',
  'completed',
  'cancelled',
  'rejected',
];

const transferItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    barcode: { type: String, default: '' },
    unitCostCents: { type: Number, default: 0, min: 0 },
    requestedQty: { type: Number, required: true, min: 1 },
    dispatchedQty: { type: Number, default: 0, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
    imeis: { type: [String], default: [] },
    receivedImeis: { type: [String], default: [] },
    discrepancyQty: { type: Number, default: 0 },
    discrepancyNote: { type: String, default: '', trim: true },
  },
  { _id: true }
);

const stockTransferSchema = new mongoose.Schema(
  {
    transferNumber: { type: String, required: true, trim: true },
    fromBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    toBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    status: { type: String, enum: TRANSFER_STATUSES, default: 'requested', index: true },
    items: { type: [transferItemSchema], default: [] },
    totalTransferCostCents: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', trim: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    requestedAt: { type: Date, default: () => new Date() },
    approvedAt: { type: Date, default: null },
    dispatchedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stockTransferSchema.plugin(tenantPlugin);
stockTransferSchema.index({ tenantId: 1, transferNumber: 1 }, { unique: true });
stockTransferSchema.index({ tenantId: 1, fromBranchId: 1, status: 1 });
stockTransferSchema.index({ tenantId: 1, toBranchId: 1, status: 1 });

export default mongoose.models.StockTransfer || mongoose.model('StockTransfer', stockTransferSchema);
