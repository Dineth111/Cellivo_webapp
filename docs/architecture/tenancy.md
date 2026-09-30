# Multi-tenancy (SRS section 6)

Every tenant-owned collection is scoped by `tenantId`. Scoping is automatic and **fails closed**: a query on a tenant model with no tenant context throws.

## For feature developers

```js
import tenantPlugin from '../../core/tenantPlugin.js';

const schema = new mongoose.Schema({ /* fields, no tenantId */ });
schema.plugin(tenantPlugin);                 // adds tenantId (required, immutable, indexed)
schema.index({ tenantId: 1, sku: 1 }, { unique: true });   // uniques MUST include tenantId
```

That is all. In request handlers the tenant context is set by the `protect` middleware from the session, so just write normal Mongoose code:

```js
await Product.find({ brand: 'Apple' });      // WHERE tenantId = <current tenant> AND brand = ...
await Product.create({ name: 'x' });         // tenantId filled in
```

What the plugin does

| Operation | Behaviour |
|---|---|
| `find`, `findOne`, `findById`, `countDocuments`, `distinct` | `tenantId` added to filter (overrides any tenantId you pass) |
| `update*`, `findOneAnd*`, `replaceOne`, `delete*` | filter scoped; `tenantId` stripped from the update |
| `aggregate` | `{ $match: { tenantId } }` prepended |
| `save`, `create`, `insertMany` | `tenantId` set; writing another tenant's id throws |
| `bulkWrite`, `estimatedDocumentCount` | throw (unscoped). Platform code only |
| any of the above with no context | throws `Tenant context missing` |

## Context API (`src/core/tenantContext.js`)

- `runWithContext({ tenantId, userId, ... }, fn)` – used by `protect`, background jobs, tests. Backed by `AsyncLocalStorage`.
- `getContext()` – current `{ tenantId, userId, sessionId, role, branchIds, permissions, ip, device }`.
- `currentTenantId()` – ObjectId or throws.
- `runAsPlatform(fn)` – **explicit opt-out**, everything inside is unscoped. Only for platform-level lookups (login by email, platform admin dashboard). Keep the callback tiny and `await` inside it.

## Gotchas

- Always `await` the query **inside** the callback: `runWithContext(ctx, async () => await Model.find())`. A returned un-awaited Query executes after the context has ended and will throw.
- Background jobs (cron, queues, webhooks) have no request: wrap them in `runWithContext({ tenantId }, ...)`.
- Aggregations with `$geoNear`/`$search` must be first stage; the injected `$match` would break that. Do those inside `runAsPlatform` with a manual tenant match, and tell Dev 1.
- Transactions: pass `{ session }` explicitly, as usual.
- Stock changes only via the stock service, money only via the ledger service (see team rules); both are tenant models like any other.
- Tenant isolation tests: `backend/test/tenancy.test.js` and `backend/test/isolation.test.js`. Add your models to the latter.
