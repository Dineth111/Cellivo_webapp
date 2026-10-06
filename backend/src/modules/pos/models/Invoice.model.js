import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const invoiceLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, trim: true },
    barcode: { type: String, default: '', trim: true },
    imei: { type: String, default: null, trim: true },
    qty: { type: Number, required: true, min: 1, default: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    costPriceCents: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmountCents: { type: Number, default: 0, min: 0 },
    taxRatePercent: { type: Number, default: 0, min: 0 },
    grossCents: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, default: 0, min: 0 },
    netCents: { type: Number, required: true, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    lineTotalCents: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'Walk-in Customer', trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    nic: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    idempotencyKey: { type: String, default: undefined, trim: true },
    status: {
      type: String,
      enum: ['draft', 'completed', 'voided', 'partially_returned', 'returned'],
      default: 'completed',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'partially_paid', 'paid', 'overdue'],
      default: 'paid',
      index: true,
    },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: { type: customerSnapshotSchema, default: () => ({}) },
    salespersonId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    subtotalCents: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, default: 0, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    tradeInCents: { type: Number, default: 0, min: 0 },
    grandTotalCents: { type: Number, required: true, min: 0 },
    totalPaidCents: { type: Number, default: 0, min: 0 },
    changeDueCents: { type: Number, default: 0, min: 0 },
    lines: {
      type: [invoiceLineSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'An invoice must have at least one line'],
    },
    installmentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstallmentPlan', default: null, index: true },
    notes: { type: String, default: '', trim: true },
    voidReason: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

invoiceSchema.plugin(tenantPlugin);
invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
invoiceSchema.index({ tenantId: 1, branchId: 1, status: 1 });
invoiceSchema.index({ tenantId: 1, 'lines.imei': 1 });

export default mongoose.models.PosInvoice || mongoose.model('PosInvoice', invoiceSchema, 'pos_invoices');
