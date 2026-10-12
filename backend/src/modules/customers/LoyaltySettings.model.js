import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

const loyaltySettingsSchema = new mongoose.Schema(
  {
    pointsPerHundredRupees: { type: Number, default: 1, min: 0 },
    valuePerPointCents: { type: Number, default: 100, min: 0 },
    minRedemptionPoints: { type: Number, default: 100, min: 0 },
    expiryDays: { type: Number, default: 365, min: 0 },
  },
  { timestamps: true }
);

loyaltySettingsSchema.plugin(tenantPlugin);
loyaltySettingsSchema.path('tenantId')._index = { unique: true };

export default mongoose.models.LoyaltySettings || mongoose.model('LoyaltySettings', loyaltySettingsSchema);
