import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const productModelSchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: [true, 'Brand is required'], index: true },
    name: { type: String, required: [true, 'Model name is required'], trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

productModelSchema.plugin(tenantPlugin);
productModelSchema.index({ tenantId: 1, brandId: 1, name: 1 }, { unique: true });

export default mongoose.models.ProductModel || mongoose.model('ProductModel', productModelSchema);
