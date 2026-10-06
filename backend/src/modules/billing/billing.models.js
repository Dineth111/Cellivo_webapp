import mongoose from 'mongoose';
import { BILLING_TERMS, CURRENCIES } from '../tenants/Tenant.model.js';

// Subscription billing is PLATFORM data (Cellivo charging shops), not shop data, so none of these use
// tenantPlugin. Routes that expose them to a shop MUST filter by req.auth.tenantId.
// Money is stored as integers in minor units (cents), never floats (SRS section 6).

const { Schema } = mongoose;
const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });

/** Atomic running numbers: SUB-5001, SUB-5002 ... */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
export const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);
export const nextNumber = async (name, start = 5000) =>
  (await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true })).seq + start;

const refundSchema = new Schema({ amount: Number, reason: String, by: String, at: { type: Date, default: Date.now } }, { _id: false });

const invoiceSchema = new Schema(
  {
    number: { type: String, required: true, unique: true }, // SUB-5001
    tenantId: { ...oid('Tenant'), required: true, index: true },
    kind: { type: String, enum: ['new', 'upgrade', 'renewal', 'offline'], required: true },
    planCode: { type: String, required: true },
    term: { type: String, enum: BILLING_TERMS, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    // all minor units: total = price - discount - credit + tax
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    credit: { type: Number, default: 0 }, // proration credit for the unused part of the old plan
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    couponCode: { type: String, default: null },
    status: { type: String, enum: ['paid', 'refunded', 'partially_refunded', 'void'], default: 'paid' },
    method: { type: String, default: 'card' }, // card | bank_transfer
    reference: { type: String, default: '' },
    periodStart: Date,
    periodEnd: Date, // null for lifetime
    billTo: { name: String, address: String, taxNumber: String },
    refunds: [refundSchema],
    paidAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
export const refundedTotal = (inv) => inv.refunds.reduce((s, r) => s + r.amount, 0);
export const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);

/** One row per charge attempt, including the failed ones (A-06 "failed charges"). */
const paymentSchema = new Schema(
  {
    tenantId: { ...oid('Tenant'), required: true, index: true },
    invoiceId: oid('Invoice'),
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    status: { type: String, enum: ['paid', 'failed'], required: true },
    method: { type: String, default: 'card' },
    gateway: { type: String, default: 'test' },
    gatewayRef: { type: String, default: '' },
    error: { type: String, default: '' },
    attempt: { type: Number, default: 1 }, // 1 = first renewal charge, 2.. = retries (days 1, 3, 5)
  },
  { timestamps: true }
);
export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

/** In-app warnings shown on the portal ("email and in-app warning each time", FRS F-02). */
const noticeSchema = new Schema(
  {
    tenantId: { ...oid('Tenant'), required: true, index: true },
    kind: { type: String, required: true }, // payment_failed | suspended | trial_ending | cancelled ...
    message: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const Notice = mongoose.models.Notice || mongoose.model('Notice', noticeSchema);

const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 30 },
    type: { type: String, enum: ['percent', 'fixed'], required: true },
    percent: { type: Number, min: 1, max: 100, default: null },
    fixed: { USD: { type: Number, min: 0, default: 0 }, LKR: { type: Number, min: 0, default: 0 } }, // major units
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    maxUses: { type: Number, default: null, min: 1 },
    perTenantLimit: { type: Number, default: 1, min: 1 },
    plans: { type: [String], default: [] }, // empty = all
    terms: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    usedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
