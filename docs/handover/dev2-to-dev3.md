# Handover: Dev 2 to Dev 3

Branch: `dev-2` (merge to `main` via PR before you branch: `feature/F-xx-name`). Read first: `dev1-to-dev2.md` (the foundation rules still apply), `docs/architecture/tenancy.md`, `docs/api/core.md`, `dev2-status.md`.

## Setup

Same as `dev2-status.md`. `npm test` runs in-memory MongoDB; run test files one at a time while developing (`npx vitest run test/yourfile.test.js`).

## Yours to build (README allocation)

F-09 POS sale and printing, F-10 returns, trade-ins and wholesale, F-11 credit and installments, F-14 cash drawer and finance, loyalty, and the **ledger service** that every other developer posts money through. Dev 4 (purchasing) and Dev 5 (repair invoices) are waiting on the ledger.

## What you build on from Dev 2

| Thing | Where | How you use it |
|---|---|---|
| Plan limits and feature flags | `modules/plans/planLimits.js` | `router.use(protect, subscriptionGuard)` on every POS route; `requireFeature('pos' / 'credit' / 'returns_wholesale')` on the matching routes |
| Plan feature defaults | `modules/plans/plans.service.js` | Lite has only `pos`; Starter and above have every module except `woocommerce`. Admins can edit these, so never hard-code a plan name, ask `requireFeature` |
| Read-only for unpaid shops | `subscriptionGuard` | Suspended, expired and cancelled shops get 402 on writes (`SUBSCRIPTION_SUSPENDED`), archived shops are blocked entirely. A sale must fail the same way, so mount the guard before your routes |
| Shared UI | `frontend/src/components/ui.js` | `Button`, `Field`, `Card`, `Badge`, `Alert`, `Table`, `Hero`, `Stat`, `AppHeader`, `money()`, `date()`. Tokens are in `globals.css` (SRS 10.1) |
| Customers | `modules/customers/` | Credit, installments and loyalty attach to these |

## Rules that matter for money

- **Two kinds of money, keep them apart.** Subscription money (Cellivo charging a shop) lives in `modules/billing` (`Invoice`, `Payment`) and is platform data. **Shop sales, cash, credit and refunds are yours and belong in the ledger**, as tenant models (`schema.plugin(tenantPlugin)`, unique indexes include `tenantId`, add each model to `test/isolation.test.js`).
- Store money as integers in minor units (cents), never floats. Plan prices are the only major-unit values and they are Dev 2's.
- Coupons in `billing.models.js` are Cellivo subscription coupons. Shop discounts, price overrides and discount limits are a different thing: they come from the role (`discountLimit`, `override_price`) in the request context.
- Always `await` inside `runWithContext` / `runAsPlatform` callbacks. A bare query runs after the context ends and fails with "Tenant context missing".
- Stock changes only through Dev 4's stock service. Do not touch stock collections from a sale.

## Open items that block you

- **Approval PIN (POS-04).** The PIN is stored (bcrypt) but there is no verify endpoint. `OPEN_QUESTIONS.md` item 11 suggests `POST /api/users/verify-pin` returning the approver's id, rate limited. Dev 1 owns it; ask for it early.
- **Receipts and customer SMS or email** go through Dev 5's notification service (due week 8). Until then log to the console as `signup.service.js` does.
- **Plan reports gating.** The `advanced_reports` flag exists; the Lite plan restriction on reports is Dev 5's to apply with `requireFeature`.

## Contacts

Ledger design and tenant isolation changes need Dev 1's approval. Plan names, feature flags or limits you need that do not exist yet: add the feature name to `FEATURES` in `modules/plans/Plan.model.js` and the default plans in `plans.service.js`, and tell Dev 2.
