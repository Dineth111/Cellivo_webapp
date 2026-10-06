import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const creditNoteItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, trim: true },
    barcode: { type: String, default: '', trim: true },
    imei: { type: String, default: null, trim: true },
    qty: { type: Number, required: true, min: 1, default: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    refundCents: { type: Number, required: true, min: 0 },
    condition: {
      type: String,
      enum: ['Resellable', 'Damaged', 'To supplier'],
      default: 'Resellable',
    },
    reason: { type: String, default: 'Customer return', trim: true },
  },
  { _id: true }
);

const creditNoteSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    creditNoteNumber: { type: String, required: true, trim: true },
    originalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'PosInvoice', required: true, index: true },
    originalInvoiceNumber: { type: String, required: true, trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    items: {
      type: [creditNoteItemSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'Credit note must contain at least one item'],
    },
    subtotalCents: { type: Number, required: true, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    totalRefundCents: { type: Number, required: true, min: 0 },
    refundMethod: {
      type: String,
      enum: ['cash', 'card', 'store_credit', 'original'],
      default: 'cash',
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

creditNoteSchema.plugin(tenantPlugin);
creditNoteSchema.index({ tenantId: 1, creditNoteNumber: 1 }, { unique: true });
creditNoteSchema.index({ tenantId: 1, originalInvoiceId: 1 });

export default mongoose.models.CreditNote || mongoose.model('CreditNote', creditNoteSchema);
