import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Category name is required'], trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

categorySchema.plugin(tenantPlugin);
categorySchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.models.Category || mongoose.model('Category', categorySchema);
