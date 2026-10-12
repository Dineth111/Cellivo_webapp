import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const stockLevelSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    qty: { type: Number, default: 0, min: 0 },
    averageCostCents: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

stockLevelSchema.plugin(tenantPlugin);
stockLevelSchema.index({ tenantId: 1, productId: 1, branchId: 1 }, { unique: true });
stockLevelSchema.index({ tenantId: 1, branchId: 1 });

export default mongoose.models.StockLevel || mongoose.model('StockLevel', stockLevelSchema);
