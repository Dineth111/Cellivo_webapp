import mongoose from 'mongoose';

// FRS section 5: Trial -> Active -> Past due -> Suspended -> Cancelled -> Archived; Trial -> Expired
export const TENANT_STATUSES = ['trial', 'expired', 'active', 'past_due', 'suspended', 'cancelled', 'archived'];
export const BILLING_TERMS = ['monthly', 'yearly', 'lifetime'];
export const CURRENCIES = ['USD', 'LKR'];

// Platform-level record (not tenant-scoped itself). Billing fields are owned by the billing module (Dev 2).
const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    country: { type: String, default: 'LK', trim: true, uppercase: true },
    currency: { type: String, default: 'LKR' },
    timezone: { type: String, default: 'Asia/Colombo' },
    status: { type: String, enum: TENANT_STATUSES, default: 'trial' },
    trialEndsAt: { type: Date, default: null },
    idleTimeoutMinutes: { type: Number, default: 30, min: 10, max: 240 },

    // plan and subscription (null planCode = legacy account that never chose a plan)
    planCode: { type: String, default: null, lowercase: true },
    billingTerm: { type: String, enum: BILLING_TERMS, default: 'monthly' },
    billingCurrency: { type: String, enum: CURRENCIES, default: 'LKR' },
    subscription: {
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null }, // null for lifetime plans
      pendingPlanCode: { type: String, default: null }, // downgrade applied at next renewal
      pendingBillingTerm: { type: String, default: null },
      cancelAtPeriodEnd: { type: Boolean, default: false },
      cancelledAt: { type: Date, default: null },
      archivedAt: { type: Date, default: null },
      pastDueSince: { type: Date, default: null },
      retriesDone: { type: Number, default: 0 },
      freeUntil: { type: Date, default: null }, // admin "grant a free period"
    },
    paymentMethod: {
      brand: { type: String, default: '' },
      last4: { type: String, default: '' },
      token: { type: String, default: '', select: false }, // gateway token, never sent to the client
    },
    billingDetails: {
      name: { type: String, default: '', maxlength: 120 },
      address: { type: String, default: '', maxlength: 300 },
      taxNumber: { type: String, default: '', maxlength: 40 },
    },

    // growth
    couponCode: { type: String, default: null, uppercase: true },
    affiliateCode: { type: String, default: null, uppercase: true },
    affiliateBannerHiddenUntil: { type: Date, default: null },
    branchLimitOverride: { type: Number, default: null, min: 0 }, // admin override (A-03)
    smsCredits: { type: Number, default: 0, min: 0 },
    notes: [{ text: String, by: String, at: { type: Date, default: Date.now }, _id: false }],
    lastActivityAt: { type: Date, default: null },
    phone: { type: String, default: '' },
    ownerEmail: { type: String, default: '', lowercase: true },
    ownerName: { type: String, default: '' },
  },
  { timestamps: true }
);
tenantSchema.index({ status: 1 });
tenantSchema.index({ ownerEmail: 1 });

export default mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
