import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

const loyaltySettingsSchema = new mongoose.Schema(
  {
    pointsPerHundredRupees: { type: Number, default: 1, min: 0, max: 1000 },
    valuePerPointCents: { type: Number, default: 100, min: 0, max: 10000 },
    minRedemptionPoints: { type: Number, default: 100, min: 0, max: 1000000 },
    expiryDays: { type: Number, default: 365, min: 0, max: 3650 },
  },
  { timestamps: true }
);

loyaltySettingsSchema.plugin(tenantPlugin);
// tenantPlugin adds tenantId with `index: true` (non-unique). Override the path-level
// index descriptor in-place to make it unique for this one-per-tenant model.
// Using ._index rather than schema.index() avoids registering a second index definition
// under the same auto-generated name "tenantId_1", which would cause a MongoDB error.
loyaltySettingsSchema.path('tenantId')._index = { unique: true };

export default mongoose.models.LoyaltySettings || mongoose.model('LoyaltySettings', loyaltySettingsSchema);
