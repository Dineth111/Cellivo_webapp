import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Brand name is required'], trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

brandSchema.plugin(tenantPlugin);
brandSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.models.Brand || mongoose.model('Brand', brandSchema);
