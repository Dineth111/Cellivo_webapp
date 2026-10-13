import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const repairPartSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: null, trim: true },
    qty: { type: Number, required: true, min: 1, default: 1 },
    unitCostCents: { type: Number, default: 0, min: 0 },
    unitPriceCents: { type: Number, default: 0, min: 0 },
    serial: { type: String, default: null, trim: true },
    addedAt: { type: Date, default: () => new Date() },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: true }
);

const repairHistorySchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const repairTicketSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, trim: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    device: {
      brand: { type: String, required: true, trim: true },
      model: { type: String, required: true, trim: true },
      imei: { type: String, default: null, trim: true },
      serial: { type: String, default: null, trim: true },
      colour: { type: String, default: null, trim: true },
    },
    passcodeEncrypted: {
      encrypted: { type: String, default: null },
      iv: { type: String, default: null },
      tag: { type: String, default: null },
    },
    accessories: { type: [String], default: [] },
    conditionNotes: { type: String, default: '', trim: true },
    photoUrls: {
      type: [String],
      default: [],
      validate: [(v) => Array.isArray(v) && v.length <= 6, 'Maximum 6 photo URLs allowed'],
    },
    faultDescription: { type: String, required: true, trim: true },
    estimateCents: { type: Number, default: 0, min: 0 },
    advanceCents: { type: Number, default: 0, min: 0 },
    advancePaymentMethod: { type: String, default: 'cash', trim: true },
    advanceSettled: { type: Boolean, default: false },
    advanceDecision: { type: String, enum: ['none', 'refund', 'keep_fee'], default: 'none' },
    advanceFeeCents: { type: Number, default: 0, min: 0 },
    promisedDate: { type: Date, default: null, index: true },
    stage: {
      type: String,
      enum: [
        'Received',
        'Diagnosing',
        'Waiting approval',
        'Waiting parts',
        'In repair',
        'Quality check',
        'Ready',
        'Delivered',
        'Unrepairable',
        'Cancelled',
      ],
      default: 'Received',
      index: true,
    },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    approval: {
      status: { type: String, enum: ['none', 'pending', 'approved', 'declined', 'waived'], default: 'none' },
      at: { type: Date, default: null },
      by: { type: String, enum: ['in_person', 'status_link', null], default: null },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      waivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      waivedAt: { type: Date, default: null },
    },
    parts: { type: [repairPartSchema], default: [] },
    labourCents: { type: Number, default: 0, min: 0 },
    partsCostCents: { type: Number, default: 0, min: 0 },
    isInvoiceSettled: { type: Boolean, default: false },
    invoiceId: { type: String, default: null },
    invoiceSettledAt: { type: Date, default: null },
    invoiceTotalCents: { type: Number, default: 0 },
    deliveredAt: { type: Date, default: null },
    warrantyDays: { type: Number, default: 0, min: 0 },
    warrantyExpiresAt: { type: Date, default: null, index: true },
    warrantyAlertSentAt: { type: Date, default: null },
    history: { type: [repairHistorySchema], default: [] },
    internalNotes: { type: String, default: '', trim: true },
    isArchived: { type: Boolean, default: false, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

repairTicketSchema.plugin(tenantPlugin);

// Unique ticketNo per tenant
repairTicketSchema.index({ tenantId: 1, ticketNo: 1 }, { unique: true });
repairTicketSchema.index({ tenantId: 1, stage: 1 });
repairTicketSchema.index({ tenantId: 1, branchId: 1 });
repairTicketSchema.index({ tenantId: 1, customerId: 1 });
repairTicketSchema.index({ tenantId: 1, technicianId: 1 });
repairTicketSchema.index({ tenantId: 1, promisedDate: 1 });
repairTicketSchema.index({ tenantId: 1, warrantyExpiresAt: 1 });

export default mongoose.models.RepairTicket || mongoose.model('RepairTicket', repairTicketSchema);
