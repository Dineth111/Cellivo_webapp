# Core API (Dev 1)

Base URL: `http://localhost:5000/api`. JSON in, JSON out.

## Formats

Success: `{ "success": true, "message"?: string, "data"?: ..., "count"?: n }`
Paginated lists add `page`, `limit`, `total`.

Error: `{ "success": false, "message": "human readable", "code"?: "MACHINE_CODE", "data"?: ... }`
Outside `NODE_ENV=development` 5xx errors say only "Internal Server Error", there is no stack trace, and a duplicate-key error never names the field.

| Status | Meaning |
|---|---|
| 400 | validation failed (message says what to fix) |
| 401 | not logged in / token expired (`code: TOKEN_EXPIRED` or `SESSION_EXPIRED`) |
| 403 | logged in but not allowed |
| 404 | not found. **Also returned for records that belong to another tenant** |
| 409 | conflict (duplicate email, last owner, role in use, duplicate phone) |
| 429 | rate limited (`/api/auth/*`, default 100 per 15 min per IP) |

## Authentication header

```
Authorization: Bearer <access token>
```

Access token: JWT, 15 minutes (`ACCESS_TOKEN_TTL`), carries only a session id. The session lives in MongoDB, so it can be revoked at once (logout, remote logout, deactivation, password change) and expires after the tenant's idle timeout (default 30 min, 10 to 240). Login and register also return a `refreshToken`; `POST /auth/refresh {refreshToken}` returns a new `{ token, refreshToken }`. The refresh token rotates and works once.

## Endpoints

Legend: Auth = login required, then the permission needed.

### Public

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | /health | | DB status |
| POST | /auth/register | name, shopName, email, password, phone?, country? | Provisions tenant + trial + owner. **Temporary**: Dev 2 owns sign-up |
| POST | /auth/login | email, password | Same 401 message for unknown email, wrong password, locked and deactivated |
| POST | /auth/refresh | refreshToken | |
| POST | /auth/forgot-password | email | Always 200. Link valid 30 min, single use (logged to console in development) |
| POST | /auth/reset-password | token, password | |
| POST | /auth/set-password | token, password | Accept a staff invitation (valid 48 h) |

Password policy: 8 to 72 bytes, at least one letter and one number.

### Logged in

| Method | Path | Permission |
|---|---|---|
| POST | /auth/logout | any |
| GET | /auth/me | any (user, role, permissions, tenant) |
| PUT | /auth/profile `{name?, phone?, password?+currentPassword}` | any |
| PUT | /auth/change-password `{currentPassword, newPassword}` | any (logs out all other sessions) |
| GET | /auth/sessions | any (mine) |
| GET | /auth/sessions/tenant | owner |
| DELETE | /auth/sessions/:id | own session, or any session for the owner |
| GET/POST | /users | staff.view / staff.create (POST invites) |
| GET/PUT | /users/:id | staff.view / staff.edit |
| POST | /users/:id/deactivate, /activate | staff.edit |
| GET/POST | /roles | owner |
| GET/PUT/DELETE | /roles/:id | owner. Owner role is immutable; default roles cannot be deleted |
| GET | /branches | branches.view (own branches, or all with view_all_branches) |
| GET | /audit `?user&action&from&to&page&limit` | owner |
| GET/POST | /customers, GET/PUT/DELETE /customers/:id | customers.view/create/view/edit/delete (DELETE archives) |

Login response: `{ token, refreshToken, user: { _id, name, email, shopName, role: {key,name}, permissions: { grid, special, discountLimitPercent }, branchIds, tenant } }`.

## Using the core from your module

```js
import { protect } from '../../core/auth.js';
import { requirePermission, requireSpecial, requireOwner } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import audit from '../../core/audit.js';
import { getContext } from '../../core/tenantContext.js';

const router = express.Router();
router.use(protect);                       // 401 unless valid session; sets tenant context

router.get('/', requirePermission('inventory.view'), wrap(list));
router.put('/:id/price', requirePermission('inventory.edit'), requireSpecial('override_price'), wrap(setPrice));
```

- **Permissions**: `requirePermission('<module>.<action>')`. Modules: dashboard, pos, returns, inventory, purchases, repairs, customers, finance, cash_drawer, staff, payroll, branches, reports, settings. Actions: view, create, edit, delete, approve. The name is validated when the route is defined, so a typo crashes at startup. Always check on the server; the frontend only hides buttons.
- **Special permissions**: `requireSpecial(name)`: view_cost_margin, override_price, approve_discount, void_invoice, approve_return, adjust_stock, view_all_branches, export_reports. Inside a handler: `hasSpecial(getContext().role, 'view_cost_margin')`. **Hide cost and profit fields from anyone without `view_cost_margin`** (SEC-05).
- **Context**: `getContext()` returns `{ tenantId, userId, sessionId, role, branchIds, discountLimit, ip, device }`. Also on `req.auth`. Models that use `tenantPlugin` are scoped automatically (see docs/architecture/tenancy.md).
- **Errors**: `throw badRequest('...')`, `forbidden()`, `notFound()`, `conflict()` from `core/errors.js`, and wrap async handlers in `wrap()`.
- **Input**: never spread `req.body` into a model. Use `pick(body, [...])` and `str()` from `core/validate.js`; check ids with `requireId()`.
- **Audit**: `await audit.record({ action: 'invoice.void', entity: 'Invoice', entityId: inv._id, before, after })`. Tenant, user, IP and device come from the context. Passwords, tokens and PIN hashes are stripped automatically. It never throws, so it cannot break the user's action. Record every create, edit, delete, price override, discount approval and permission change (SEC-09).
- **Unique indexes** on tenant models must include `tenantId`.
