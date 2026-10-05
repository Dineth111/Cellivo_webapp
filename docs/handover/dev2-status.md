# Dev 2 status: sign-up, billing, plan limits, platform admin

Branch: `dev-2`. Follows `dev1-to-dev2.md`. Everything below is built and tested unless it is listed under "Not done".

## Run and test

```
cd backend && npm install && npm run dev     # API :5000 (billing job runs every BILLING_JOB_MINUTES, default 60, 0 = off)
node src/createAdmin.js "Name" you@cellivo.lk super_admin "Password1"   # first platform admin
npm test                                      # 74 tests, in-memory MongoDB replica set
cd ../frontend && npm install && npm run dev  # :3000  (/signup, /billing, /admin)
```
`npm test` as one run is slow (several minutes); each file passes on its own (`npx vitest run test/billing.test.js`).
Dev sign-up codes are printed to the API console (no email yet). Test card numbers: `4242424242424242` pays, `4000000000000002` is declined.

## What exists

| Area | Where | Notes |
|---|---|---|
| Plans and limits | `modules/plans/` | `Plan` model (platform data, edited in admin), seeded on first use |
| Sign-up F-01 | `modules/signup/` | start, code by email (console for now), verify creates the shop through `provisionTenant()` and starts the trial |
| Billing F-02, F-20 | `modules/billing/` | quote, subscribe, upgrade (prorated), downgrade (at renewal), cancel, coupons, invoices and PDF, renewal job with retries on days 1, 3, 5 and suspension |
| Public hooks | `modules/public/` | plans, contact and demo forms (honeypot), announcements |
| Platform admin | `modules/admin/`, `modules/growth/` | separate `AdminUser`, password plus TOTP, IP allow-list, five roles, append-only audit log, `/api/admin/*` |
| Frontend | `frontend/src/app/{signup,billing,admin}`, `components/ui.js`, `lib/adminApi.js` | shared UI library plus the three screens |

## For other developers: plan limits and feature flags

```js
import { subscriptionGuard, requireFeature, assertBranchLimit, assertCanAddUser } from '../plans/planLimits.js';
router.use(protect, subscriptionGuard);                    // suspended, expired and cancelled shops become read-only (402); archived shops are blocked
router.post('/', requireFeature('repairs'), wrap(create)); // 403 with the upgrade message if the plan lacks the module
await assertBranchLimit(req.tenant);                       // before creating a branch (BR-01)
```
Feature names are in `modules/plans/Plan.model.js` (`FEATURES`). Put `subscriptionGuard` on every new shop route; billing and auth routes stay outside it so a suspended shop can still pay and export.

## Behaviour worth knowing

- Money is stored in minor units (cents). Plan prices are in major units.
- An admin token (`aud: admin`) is never accepted by the shop API and the reverse.
- Admin changes to a shop always need a reason and are written to `AdminAudit`.
- The payment gateway is a test gateway (`PAYMENT_GATEWAY=test`). Swap it in `billing/gateway.js`.
- Queries made inside `runWithContext` / `runAsPlatform` must be awaited inside the callback; a bare query runs after the context ends. Two bugs in this work were exactly that.

## Not done

- Real payment gateway (needs a provider and credentials).
- Email sending: Dev 5. Sign-up codes, trial and payment emails only log to the console.
- Public website pages: pricing, contact and demo booking screens (the API hooks exist). Terms and Privacy pages.
- No screen to manage admin users (the API exists). The admin console covers shops, payments, plans, leads, audit and the simple collections.
- The shop login at `/` and the shop dashboard still have the old look; no subscription banner inside the shop dashboard.
- Retention job: archived shops are not deleted after 90 days.
- Decisions for Dev 1: where refresh tokens are stored, and who owns the shared TOTP code (admin login has its own in `admin.auth.js`).
