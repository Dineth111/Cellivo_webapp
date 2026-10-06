# Handover: Dev 1 to Dev 2

Branch: `pahasara-(dev)` (merge to `main` via PR before you branch: `feature/F-xx-name`). Read first: `docs/architecture/tenancy.md`, `docs/api/core.md`, `OPEN_QUESTIONS.md`.

## Setup (10 minutes)

```
cd backend && cp .env.example .env     # set MONGO_URI and JWT_SECRET (server won't start without them)
npm install && npm run dev             # API :5000
npm run seed                           # demo shop, owner@cellivo.lk / Cellivo@123 (all 5 roles, same password)
npm test                               # 43 tests, in-memory MongoDB replica set
cd ../frontend && npm install && npm run dev   # :3000
```
`frontend/AGENTS.md`: this Next.js has breaking changes. Read `node_modules/next/dist/docs/` before routing/layout work.

## What already exists that you build on

| Thing | Where | Notes |
|---|---|---|
| Tenant model (status, trialEndsAt, idleTimeoutMinutes) | `modules/tenants/Tenant.model.js` | No plan, term, billing or limit fields yet. Add them |
| `provisionTenant()` | `modules/tenants/provisioning.service.js` | Transactional: tenant, Main Branch, 5 roles, owner. Reuse it in your sign-up |
| `POST /api/auth/register` | `modules/auth/auth.controller.js` | **Temporary**, marked TODO. Replace with F-01: email/phone verification, plan and term from pricing page, affiliate/coupon, setup wizard |
| Sessions, login, refresh, reset, invite | `modules/auth/` | Done. Reuse for the portal login |
| `protect`, `requirePermission`, `requireOwner`, `audit.record` | `core/` | Usage in `docs/api/core.md` |
| `runAsPlatform(fn)` | `core/tenantContext.js` | Unscoped access. Your admin dashboard will need it (keep callbacks tiny, `await` inside) |
| Frontend login/register, token + refresh handling | `frontend/src/lib/api.js`, `app/page.js` | Minimal only. No UI library |

## Yours to build (from the allocation document)

1. **Shared UI library**, needed by everyone from week 3. Nothing exists. Tokens are in SRS/FRS section 10.1 (Plus Jakarta Sans, #445EE4 primary, etc.).
2. **Plan-limit and feature-flag service**, needed by week 6. Others are waiting on it. Known TODOs pointing at it: custom roles Starter+ (`roles.controller.js`), branch limit on create (BR-01), Lite plan reports.
3. **F-01, F-02, F-20** sign-up, subscriptions/payments, portal home.
4. **Platform admin A-01 to A-16.**

## Decisions you need to make or know about

- **Platform admin users do not exist.** All current users belong to a tenant. You need a separate `AdminUser` model, its own login (mandatory 2FA, IP allow-list per FRS section 4) and roles (Super Admin, Support, Sales, Finance, Content). Do not reuse the tenant `User`/`protect`. Tenant `Session`/`AuditLog` are tenant-scoped, so the platform audit log (ADM-27) is a separate collection.
- **Suspended tenants:** FRS F-02 says they may only reach Billing. `req.auth.tenantStatus` is available in `protect`, nothing enforces it yet. Best done as a middleware you own.
- **Tenant `status`** enum already matches the FRS subscription model (`trial, active, past_due, suspended, cancelled, archived`).
- **Email is unique across the whole platform** (login has no tenant field).
- **Refresh tokens live in localStorage/sessionStorage** (OPEN_QUESTIONS 13). Decide before the portal launches.
- **2FA, IP allow-list, device approval** (SEC-03/06/07) are not built. They are Dev 1 items, but your admin login needs 2FA, so agree who builds the shared TOTP piece.
- `TRIAL_DAYS` env var is a stand-in for the platform-admin trial setting (ACC-04).

## Rules that will bite you

- Every tenant model gets `schema.plugin(tenantPlugin)`; unique indexes must include `tenantId`. Add the model to `test/isolation.test.js`.
- Cross-tenant ids return **404**, not 403.
- Never spread `req.body` into a model; use `pick`/`str` from `core/validate.js`.
- Always `await` inside `runWithContext`/`runAsPlatform` callbacks, or the context is gone.
- Stock only via Dev 4's stock service, money only via Dev 3's ledger. For subscription payments you own the gateway, but tenant-shop money is Dev 3's.
- Line endings are mixed (CRLF/LF); ignore the git warnings.

## Contacts and dependencies

Notification service (welcome, trial ending, payment failed emails) is Dev 5's, due week 8. Until then log links to the console as `auth.service.js` does. Ask Dev 1 (schema changes and anything touching tenant isolation or security need my approval).
