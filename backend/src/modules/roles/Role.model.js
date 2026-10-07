import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';
import { MODULES, ACTIONS, SPECIALS } from '../../core/permissions.js';

const bool = { type: Boolean, default: false };
const grid = Object.fromEntries(MODULES.map((m) => [m, Object.fromEntries(ACTIONS.map((a) => [a, bool]))]));
const special = Object.fromEntries(SPECIALS.map((s) => [s, bool]));

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 40 },
    // key is set only on the 5 default roles (owner, branch_manager, cashier, technician, accountant)
    key: { type: String, default: null, immutable: true },
    isSystem: { type: Boolean, default: false, immutable: true },
    grid,
    special,
    discountLimitPercent: { type: Number, default: 0, min: 0, max: 100 },
    tradeInLimitCents: { type: Number, default: 0, min: 0 }, // POS ignores it for the owner (no limit)
  },
  { timestamps: true, minimize: false }
);
roleSchema.plugin(tenantPlugin);
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.models.Role || mongoose.model('Role', roleSchema);
