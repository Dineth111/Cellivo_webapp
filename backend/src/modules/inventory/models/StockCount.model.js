import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const stockCountItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    barcode: { type: String, required: true },
    expectedQty: { type: Number, default: 0 },
    countedQty: { type: Number, default: 0 },
    varianceQty: { type: Number, default: 0 }, // countedQty - expectedQty
    unitCostCents: { type: Number, default: 0 },
    varianceCostCents: { type: Number, default: 0 },
    scannedImeis: { type: [String], default: [] },
    unknownImeis: { type: [String], default: [] },
  },
  { _id: true }
);

const stockCountSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    countNumber: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'in_progress', 'completed', 'approved', 'cancelled'],
      default: 'draft',
      index: true,
    },
    items: { type: [stockCountItemSchema], default: [] },
    totalVarianceQty: { type: Number, default: 0 },
    totalVarianceCostCents: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stockCountSchema.plugin(tenantPlugin);
stockCountSchema.index({ tenantId: 1, countNumber: 1 }, { unique: true });
stockCountSchema.index({ tenantId: 1, branchId: 1, createdAt: -1 });

export default mongoose.models.StockCount || mongoose.model('StockCount', stockCountSchema);
