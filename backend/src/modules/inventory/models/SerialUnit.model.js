import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const SERIAL_STATUSES = [
  'in_stock',
  'reserved',
  'sold',
  'in_transit',
  'returned',
  'with_supplier',
  'written_off',
  'in_repair',
];

const serialUnitSchema = new mongoose.Schema(
  {
    imei1: { type: String, required: [true, 'IMEI 1 is required'], trim: true },
    imei2: { type: String, trim: true, default: null },
    serialNumber: { type: String, trim: true, default: '' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    unitCostCents: { type: Number, default: 0, min: 0 },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceivedNote', default: null },
    grnNumber: { type: String, trim: true, default: '' },
    status: { type: String, enum: SERIAL_STATUSES, default: 'in_stock', index: true },
    reservation: {
      cartId: { type: String, default: null, trim: true },
      reservedUntil: { type: Date, default: null },
      reservedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    warrantyEndsAt: { type: Date, default: null },
    soldInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    soldInvoiceNumber: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

serialUnitSchema.plugin(tenantPlugin);
serialUnitSchema.index({ tenantId: 1, imei1: 1 }, { unique: true });
serialUnitSchema.index({ tenantId: 1, imei2: 1 }, { unique: true, sparse: true });
serialUnitSchema.index({ tenantId: 1, branchId: 1, status: 1 });
serialUnitSchema.index({ tenantId: 1, productId: 1, status: 1 });
serialUnitSchema.index({ tenantId: 1, serialNumber: 1 });

export default mongoose.models.SerialUnit || mongoose.model('SerialUnit', serialUnitSchema);
