import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 150 },
    sku: { type: String, trim: true, default: '' },
    barcode: { type: String, required: [true, 'Barcode is required'], trim: true, maxlength: 60 },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null, index: true },
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductModel', default: null, index: true },
    description: { type: String, default: '', trim: true },
    isSerialised: { type: Boolean, default: false, index: true },
    variantAttributes: {
      color: { type: String, trim: true, default: '' },
      storage: { type: String, trim: true, default: '' },
      ram: { type: String, trim: true, default: '' },
      other: { type: String, trim: true, default: '' },
    },
    sellingPriceCents: { type: Number, required: [true, 'Selling price is required'], min: 0 },
    wholesalePriceCents: { type: Number, default: 0, min: 0 },
    costPriceCents: { type: Number, default: 0, min: 0 },
    taxRatePercent: { type: Number, default: 0, min: 0, max: 100 },
    reorderLevel: { type: Number, default: 0, min: 0 },
    isArchived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

productSchema.plugin(tenantPlugin);
productSchema.index({ tenantId: 1, barcode: 1 }, { unique: true });
productSchema.index({ tenantId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string', $gt: '' } } });
productSchema.index({ tenantId: 1, name: 1 });
productSchema.index({ tenantId: 1, isSerialised: 1 });

export default mongoose.models.Product || mongoose.model('Product', productSchema);
