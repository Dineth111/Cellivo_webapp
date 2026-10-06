import mongoose from 'mongoose';

// Module flags (SRS 2.3 / FRS 2.2). Other developers gate their features on these names.
export const FEATURES = [
  'pos', 'imei', 'repairs', 'credit', 'returns_wholesale', 'custom_roles',
  'staff_payroll', 'advanced_reports', 'woocommerce', 'priority_support',
];

const price = { USD: { type: Number, min: 0, default: 0 }, LKR: { type: Number, min: 0, default: 0 } };

// Platform-level (not tenant-scoped). Edited from the admin dashboard (A-05).
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    rank: { type: Number, required: true }, // order of the plans; higher = bigger
    prices: { monthly: price, yearly: price, lifetime: price },
    branchLimit: { type: Number, default: 1, min: 0 }, // null = unlimited
    userLimit: { type: Number, default: null, min: 0 }, // null = unlimited
    roleKeys: { type: [String], default: null }, // null = every role; Lite allows owner + cashier only
    features: { type: [String], enum: FEATURES, default: [] },
    trialDays: { type: Number, default: 14, min: 0, max: 365 },
    visible: { type: Boolean, default: true }, // shown on the pricing page
    contactSales: { type: Boolean, default: false }, // Unlimited: no self-serve price
  },
  { timestamps: true }
);

export default mongoose.models.Plan || mongoose.model('Plan', planSchema);
