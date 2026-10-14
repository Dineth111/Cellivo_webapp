import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const ADJUSTMENT_REASONS = ['damage', 'loss', 'found', 'correction'];

const stockAdjustmentSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    adjustmentNumber: { type: String, required: true, trim: true },
    adjustmentType: { type: String, enum: ['increase', 'decrease'], required: true },
    qtyChange: { type: Number, required: true },
    reason: { type: String, enum: ADJUSTMENT_REASONS, required: true },
    unitCostCents: { type: Number, default: 0, min: 0 },
    totalCostCents: { type: Number, default: 0, min: 0 },
    imei: { type: String, default: null, trim: true },
    notes: { type: String, default: '', trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stockAdjustmentSchema.plugin(tenantPlugin);
stockAdjustmentSchema.index({ tenantId: 1, adjustmentNumber: 1 }, { unique: true });
stockAdjustmentSchema.index({ tenantId: 1, branchId: 1, createdAt: -1 });

export default mongoose.models.StockAdjustment || mongoose.model('StockAdjustment', stockAdjustmentSchema);
