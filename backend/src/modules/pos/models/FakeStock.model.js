// TEMP: replace with Developer 4's service
import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const imeiItemSchema = new mongoose.Schema(
  {
    imei: { type: String, required: true, trim: true },
    status: { type: String, enum: ['in_stock', 'reserved', 'sold'], default: 'in_stock' },
    reservedUntil: { type: Date, default: null },
  },
  { _id: false }
);

const fakeStockSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    barcode: { type: String, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'General' },
    brand: { type: String, default: '' },
    sellingPriceCents: { type: Number, required: true, min: 0 },
    costPriceCents: { type: Number, default: 0, min: 0 },
    qty: { type: Number, default: 0, min: 0 },
    imeiList: { type: [imeiItemSchema], default: [] },
  },
  { timestamps: true }
);

fakeStockSchema.plugin(tenantPlugin);
fakeStockSchema.index({ tenantId: 1, branchId: 1, barcode: 1 });
fakeStockSchema.index({ tenantId: 1, 'imeiList.imei': 1 });

export default mongoose.models.FakeStock || mongoose.model('FakeStock', fakeStockSchema);
