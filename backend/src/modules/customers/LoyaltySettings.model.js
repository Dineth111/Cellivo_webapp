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
loyaltySettingsSchema.path('tenantId')._index = { unique: true };

export default mongoose.models.LoyaltySettings || mongoose.model('LoyaltySettings', loyaltySettingsSchema);
