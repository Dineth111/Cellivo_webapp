import mongoose from 'mongoose';
import { getContext } from './tenantContext.js';

const FILTERED = [
  'find', 'findOne', 'countDocuments', 'distinct',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
];
const UPDATES = ['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'];

// Returns the tenantId to scope by, or null in platform mode. Throws with no context (fail closed).
function scope(what) {
  const ctx = getContext();
  if (ctx?.platform) return null;
  if (!ctx?.tenantId) throw new Error(`Tenant context missing: refusing ${what}. Use runWithContext() or runAsPlatform().`);
  return ctx.tenantId;
}

/**
 * Apply to every tenant-owned schema. Adds tenantId, auto-fills it on write,
 * and scopes every read/update/delete/aggregate to the current tenant.
 */
export default function tenantPlugin(schema) {
  schema.add({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true, immutable: true },
  });

  schema.pre('validate', function () {
    const tid = scope(`saving ${this.constructor.modelName}`);
    if (!tid) return; // platform mode: tenantId must be given explicitly (required validator)
    if (!this.tenantId) this.tenantId = tid;
    else if (!this.tenantId.equals(tid)) throw new Error('Cross-tenant write blocked');
  });

  schema.pre(FILTERED, function () {
    const tid = scope(`${this.op} on ${this.model.modelName}`);
    if (!tid) return;
    this.setQuery({ ...this.getFilter(), tenantId: tid });
    if (UPDATES.includes(this.op)) {
      const u = this.getUpdate();
      if (u) {
        delete u.tenantId;
        if (u.$set) delete u.$set.tenantId;
      }
    }
  });

  schema.pre('aggregate', function () {
    const tid = scope(`aggregate on ${this.model().modelName}`);
    if (tid) this.pipeline().unshift({ $match: { tenantId: tid } });
  });

  schema.pre('insertMany', function (next, docs) {
    const tid = scope(`insertMany on ${this.modelName}`);
    if (tid) for (const d of Array.isArray(docs) ? docs : [docs]) if (d && !d.tenantId) d.tenantId = tid;
    next();
  });

  // Unscoped and unfilterable: only platform code may use these.
  for (const op of ['bulkWrite', 'estimatedDocumentCount']) {
    schema.pre(op, function () {
      if (!getContext()?.platform) throw new Error(`${op} is not allowed on tenant models outside runAsPlatform()`);
    });
  }
}
