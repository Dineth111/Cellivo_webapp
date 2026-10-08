import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const MOVEMENT_TYPES = [
  'purchase_grn',
  'sale',
  'sale_return',
  'purchase_return',
  'adjustment_gain',
  'adjustment_loss',
  'transfer_in',
  'transfer_out',
  'stock_count',
  'trade_in',
  'trade_in_void',
  'initial',
];

const stockMovementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true, index: true },
    qtyChange: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    unitCostCents: { type: Number, default: 0, min: 0 },
    totalCostCents: { type: Number, default: 0, min: 0 },
    referenceType: { type: String, default: '', trim: true, index: true },
    referenceId: { type: String, default: '', trim: true, index: true },
    imei: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

stockMovementSchema.plugin(tenantPlugin);
stockMovementSchema.index({ tenantId: 1, productId: 1, branchId: 1, createdAt: -1 });
stockMovementSchema.index({ tenantId: 1, branchId: 1, createdAt: -1 });
stockMovementSchema.index({ tenantId: 1, referenceType: 1, referenceId: 1 });

export default mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
