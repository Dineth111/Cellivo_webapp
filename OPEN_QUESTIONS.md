# Open questions and review items

This document tracks cross-module questions, architectural assumptions, and review feedback between developers.

1. **Self-registration.** Should new shop owners be allowed to pick their initial role, or always default to `owner`? (Assumption: always `owner`).
2. **Branch deletion.** Are branches hard-deleted or soft-deleted? (Assumption: soft-deleted via `isActive: false` to keep audit trails intact).
3. **Session revocation.** Does logging out on one device revoke all refresh tokens or only the current session? (Assumption: current session only, unless "log out everywhere" is called).
4. **Email verification.** Is email verification mandatory before accessing the dashboard? (Assumption: yes for production, bypassed in test environment).
5. **Role modification.** Can an owner modify the built-in system roles (e.g. rename 'cashier')? (Assumption: system roles have `isSystem: true` and cannot be renamed or deleted, but their permissions grid can be edited).
6. **Audit log retention.** How long should audit log entries be retained? (Assumption: indefinite for now; automated TTL index can be added later).
7. **Default currency.** Multi-currency or Sri Lankan Rupee (LKR) only? (Assumption: LKR only for Phase 1; all money amounts stored as integer cents).
8. **Rate limiting.** What are the production rate limits for auth endpoints? (Assumption: 10 failed logins per 15 minutes per IP before temporary block).
9. **Single tenant vs Multi-tenant DB.** Confirmed multi-tenant single-database with tenantId discriminator via `tenantPlugin.js`.
10. **Password policy.** Minimum 8 characters, at least one uppercase, one lowercase, one number, and one symbol.
11. **Phone number format.** Default to Sri Lankan format (+94 / 07x) with E.164 normalization where possible.
12. **Tax configuration.** Flat 0% VAT default for Phase 1; configurable per tenant later.
13. **Receipt printing.** Thermal 80mm vs 58mm vs PDF standard. (Assumption: responsive web receipt printable to standard thermal printers).
14. **Offline mode.** Is offline POS required for Phase 1? (Assumption: No; web app requires active internet connection).
15. **Barcode format.** EAN-13, Code-128, or custom QR? (Assumption: Code-128 supported out of the box for serials and products).
16. **Trial period.** 14 days free trial upon self-registration without credit card.
17. **Language support.** English first; Sinhala and Tamil translations for customer-facing receipts and SMS.
18. **SMS gateway.** Dialog / Mobitel / Twilio adapter interface. (Assumption: mock adapter in dev/test, provider credentials per tenant in production).
19. **Payment gateway.** PayHere / WebXPay integration for subscription billing. (Assumption: stubbed in Phase 1).
20. **Data export.** GDPR / local compliance data export for shop owners (JSON / CSV).
21. **Branches endpoint** is read-only. Create/edit with the plan limit (BR-01) is not built yet.
22. **Aggregations using `$geoNear` or `$search`** cannot go through the tenant plugin (they must be the first stage). See docs/architecture/tenancy.md.
23. **Line endings.** The repo mixes CRLF and LF (Windows). Consider a `.gitattributes` with `* text=auto eol=lf`.

## POS review fixes (Dev 3)

24. ~~**Trade-in limit per role.**~~ **Resolved:** `Role.tradeInLimitCents` added, editable in the roles API (whole cents, 0 or more). **Assumption:** default roles get branch manager Rs 50,000 (5,000,000 cents), every other role 0; the owner has no limit.
25. ~~**Approval PIN lockout is in memory.**~~ **Resolved:** `users.service verifyApprovalPin` + `POST /api/users/verify-pin`; the lockout (5 wrong PINs in 15 min -> locked 15 min, 429 `PIN_LOCKED`) is stored on the requesting user and audited (`pin.verify_failed`, `pin.locked`). The POS adapter calls it.
26. ~~**PIN in a query string.**~~ **Resolved:** the GET eligibility check ignores any PIN; the PIN-checked variant is `POST /api/pos/credit/customers/:id/eligibility { pin, amountCents }`. Frontend `posApi.js` updated.
27. ~~**Existing tenants' roles.**~~ **Resolved, no migration:** there are no production tenants yet; existing data is dev/test only and gets the new defaults from a re-seed. See the go-live checklist.
28. ~~**PIN lock check is not atomic with the compare.**~~ **Resolved:** each attempt is reserved with one `findOneAndUpdate` before the bcrypt compare (only while unlocked; the 5th sets the lock), so parallel requests get at most 5 compares.

## Inventory, IMEI, Purchasing & WooCommerce review fixes (Dev 4)

29. **DocumentSequence concurrency under MongoDB transactions:** Per-branch atomic counters for GRN, PO, BIL, Supplier Payment, and Purchase Return numbers run inside multi-document transactions with an automatic backoff retry loop (`executeWithSession` / `session.withTransaction`) to handle MongoDB `WriteConflict` / `TransientTransactionError` (code 112) under high parallel load.
30. **Stock count missing & unknown IMEIs:** During stock count approval, variance is dynamically recomputed against live `StockLevel.qty`. Missing scanned serial units are transitioned to `written_off` via `transitionStatus` (reducing stock and posting Dr 5040 / Cr 1050). Unknown scanned IMEIs are recorded in `unknownImeis` response list and never auto-created into inventory.
31. **Zero-value GRN ledger entries:** GRNs with total cost 0 update inventory counts but bypass `ledgerService.postJournal` and `SupplierPayment` creation (which strictly requires `amountCents >= 1`).
32. **Cash GRN with no open session:** Cash GRNs record a cash-out via `financeService.recordCashOut` using reason `GRN <documentNumber>`. If the receiving user does not have an open cash drawer session at that branch, the cash-out will be refused by `financeService`. Confirm whether cash GRNs without an open cashier shift should block receipt or allow a ledger-only fallback.
33. **Post-commit low-stock alerts:** Low-stock threshold evaluations hook into `session.commitTransaction` and dispatch alerts only after the database transaction successfully commits, preventing phantom alerts on rolled back transactions.

## Notifications review (Dev 5)

34. **Pre-tenant emails.** Sign-up verification codes (`signup.service.js`) go directly to the email provider without writing a `NotificationLog` document, because every tenant model requires a `tenantId`. Confirm whether platform-level notification logs should be introduced in a separate collection.
35. **Permissions for notifications.** `'notifications'` is not in `core/permissions.js` `MODULES`. Notification templates and delivery logs are currently guarded by `settings.view` and `settings.edit`. Confirm if Dev 1 should add `notifications` as a distinct module in `MODULES`.
36. **Lockout notice to owner.** FRS F-03 lockout alert (line 45 in `auth.service.js`) remains unwired for Phase 1.
37. **Platform events.** `new_lead`, `demo_booking`, and `system_threshold_breach` templates are provided in defaults, but triggers are not wired yet.
38. **Serverless queue worker trigger.** `backend/api/index.js` suggests a serverless deployment where `server.js` intervals do not run; the notification queue needs a scheduled trigger if so.
39. **In-app broadcast read state.** In-app notifications with `userId: null` share one read state across all users.

## Customers review (Dev 5)

40. **Customer schema additions.** Added `tags` (`[String]`, max 50 chars per tag), `marketingOptIn` (`Boolean`, default `false`), and `mergedInto` (`ObjectId`, ref `Customer`, default `null`). Existing financial metrics (`creditLimitCents`, `currentBalanceCents`, `loyaltyPoints`) remain intact. Normalisation is write-only with no Mongoose getter to prevent accidental display mutations.
41. **LoyaltySettings model & isolation.** Created tenant-scoped `LoyaltySettings` (`pointsPerHundredRupees`, `valuePerPointCents`, `minRedemptionPoints`, `expiryDays`). Enforces tenant isolation via `tenantPlugin`. In `loyaltySettings.adapter.js`, the query is safely wrapped with `runWithContext({ tenantId })` to provide safe defaults for POS functions (e.g. `calculateEarnedPoints`) invoked outside request context.
42. **Merge reference reassignment.** Merge is atomic within a MongoDB transaction session and owner-only. Reassigns `Invoice`, `CreditNote`, `InstallmentPlan`, `LoyaltyTransaction`, `Quotation`, and `Cheque`. Specifically:
   - Does NOT change `customerSnapshot` on `Invoice` documents, preserving historical customer details at time of sale.
   - Does NOT touch `LedgerEntry` records (Dev 3's financial ledger remains an immutable double-entry log).
   - Skips `HeldCart` (in-progress transient carts are discarded or left to expire).
   - Self-merges, merges into archived/merged customers, circular merges, and cross-tenant merges are rejected with 400 or 404.
43. **Customer history scope.**
   `GET /api/customers/:id/history` returns invoices, payments, returns / credit notes, installment plans and loyalty transactions.
   Repairs (Phase 3) and devices owned (Dev 4 inventory) return empty arrays until those modules exist.
   Cost prices on invoice lines are masked through `maskCostMargins` unless the caller has the `view_cost_margin` special permission.

### For Dev 3

44. **`reassign.adapter.js` (customers/adapters) is marked TEMP.**
   During a customer merge it writes `customerId` on Invoice, CreditNote, InstallmentPlan, LoyaltyTransaction, Quotation and Cheque inside the merge transaction session.
   It does NOT touch `customerSnapshot` or `LedgerEntry`.
   Dev 3 should either approve this adapter or take ownership of the function.

45. **`completeSale` retry counter mismatch and flaky POS concurrency test.**
   In `pos/services/sale.service.js`, the while loop condition is `while (attempts < 5)` at line 373, but the transient error catch block checks `attempts < 10` at line 553. When transient errors occur under parallel load, `attempts` can reach 5, causing the loop to exit without assigning `createdInvoice` and leading to `TypeError: Cannot read properties of undefined (reading '_id')` at `sale.service.js:562` (HTTP 500).
   This causes `test/pos.test.js` ("guarantees atomic concurrency and gapless sequential numbering") to fail intermittently with a 500 status on `origin/main` (and feature branches). Dev 3 / Dev 4 should align the loop condition with the retry limit.

### For Dev 1

46. **`LoyaltySettings` unique-tenantId index.**
   `LoyaltySettings` makes `tenantId` unique with `schema.path('tenantId')._index = { unique: true }` (private Mongoose field).
   This is necessary because `tenantPlugin` already registers a non-unique `tenantId_1` index via `index: true` on the path, and calling `schema.index({ tenantId: 1 }, { unique: true })` would create a second index definition under the same auto-generated name, causing a MongoDB `createIndex` error at startup.
   Suggest `tenantPlugin` accepts a `{ unique: true }` option so one-per-tenant models do not need the private API.
   An isolation test (`isolation.test.js`, "LoyaltySettings schema constraints") guards the index — it asserts exactly one `{ tenantId: 1 }` index exists, it is unique, and a duplicate insert is rejected with `code 11000`.

47. **Existing phone data and E.164 migration.**
   All new writes store phones in E.164 format (`+94771234567`).
   Reads (duplicate check, search, CSV import) use `phoneVariants()` to match legacy formats still in the database (e.g. `0771234567`, `94771234567`).
   `npm run normalize-phones` is a one-off script (dry-run by default, `--apply` to commit) that should be run once per environment before go-live to convert all stored phones to E.164.
   After that run, `phoneVariants` is still used defensively but should no longer find mismatches.

## Repairs review (Dev 5)

48. **Repair deposits ledger account.**
   Account 2040 is now named "Accounts payable" (Dev 3 commit `8ae16eb`).
   Please provision an explicit liability account code for customer repair deposits, or confirm whether to keep 2040 or pick another code.
   Repair advance deposits temporarily use account `2020` (Store credit liability) and therefore appear in the store-credit liability balance until invoiced or refunded.

49. **Repair cash & drawer sessions.**
   Repair cash payments (intake advance, invoice settlement, cancellation fee/refund) are not currently tied to an active POS cash drawer session. Dev 3 should advise whether repair cash movements should create `CashSession` movements.

### For Dev 3

50. **Ledger accounts and referenceType request.**
   Note that 4040 (repair income) and referenceType 'repair' were preserved in the ledger and did not collide with other modules.

51. **Inventory integration & COGS posting (For Dev 3).**
   Repair invoices (`settleInvoice`) and part write-offs (`Cancelled` / `Unrepairable`) now post Dr `5010` (COGS) / Cr `1050` (Inventory reduction) for inventory-managed repair parts, matching POS behavior in `ledger.service.postSale`. The journal remains balanced and idempotent (tracking `cogsPostedCents`).
   Shop-owned repair tickets generate no customer invoice and no ledger entries.

### For Dev 4

55. **Serialised parts in repairs.**
   Serialised parts currently remain free-text on repair tickets. Dev 4 should advise whether a dedicated serial unit status (e.g. `used_in_repair` or `consumed_repair`) should be added to `SerialUnit`, or whether transitioning to `written_off` (with ticket reference) or `sold` is acceptable for serialised parts consumed in repairs.

56. **Serial unit valuation after repair.**
   When parts are consumed to repair a shop-owned serial unit, the serial unit's stored `unitCostCents` is not currently incremented with the replacement parts' cost. Dev 4 should advise if parts cost should be capitalised into the serial unit's inventory valuation upon return to stock.

57. **Dedicated stock movement type for repairs.**
   Repair parts currently use `StockMovement` type `adjustment_loss` (decrement) and `adjustment_gain` (restoration) with `referenceType: 'repair'`. Dev 4 should consider adding a dedicated `repair_part` type to `MOVEMENT_TYPES` on `StockMovement` for clearer audit trails.

58. **Shop-owned devices and sellable stock.**
   Transitioning a shop-owned unit to `in_repair` at intake decrements sellable stock level by 1 via `adjustStockLevel` (`adjustment_loss`), and returning to `in_stock` at `Ready` or `Delivered` restores it by 1 (`adjustment_gain`).

### For Dev 1

52. **Device photo storage.**
   FRS F-12 specifies device intake photos (max 6). No file storage backend exists currently, so `photoUrls` stores URLs only.

53. **Passcode encryption key.**
   Device passcodes are encrypted with AES-256-GCM using `REPAIR_PASSCODE_KEY`. If the key is unset, passcode storage is disabled with an API warning. Documented in `.env.example`.

54. **Cashier permissions for invoice and delivery.**
   `POST /api/repairs/:id/invoice` is restricted to `repairs.approve` (branch manager, owner). Cashiers currently have `repairs: 'vc'` (view and create only). Please confirm whether cashiers should be permitted to invoice repairs and mark them `Delivered` at collection time, or if manager approval/role upgrade is required.

59. **Public repair status rate limiting on serverless & trust proxy (For Dev 1).**
   - In `backend/src/app.js`, `app.set('trust proxy', config.trustProxy)` is only invoked when `config.trustProxy` is non-zero (defaults to 0). On Vercel / reverse proxies, if `TRUST_PROXY` is not enabled, `req.ip` resolves to the internal edge/proxy IP rather than the true client IP, which would cause all public status visitors through that proxy to share a single IP rate-limit bucket. Dev 1 should configure `TRUST_PROXY=1` in serverless production environments.
   - The rate limiter uses a shared MongoDB TTL collection (`public_rate_limits`) for distributed counters (60 req/15 min per IP; 10 failed manual attempts/15 min per ticket). Note that the in-memory fallback store is per-instance on serverless (degraded mode if DB is disconnected). If Dev 1 prefers an Upstash Redis store or Edge Middleware rate limiting in production, please advise.

## Reports review (Dev 5)

60. **F-17 Reports implementation & security.**
   - All report aggregations (Sales, Inventory Valuation, Repairs, Receivables Aging) are strictly tenant-scoped (each pipeline starts with a `$match: { tenantId }`) and branch-scoped unless the caller holds `view_all_branches`.
   - Date ranges are capped at 366 days max (wider queries reject with 400 `DATE_RANGE_EXCEEDED`) and evaluated against Asia/Colombo (UTC+5:30) date boundaries.
   - Cost prices, margins, and profit metrics are masked (`null`) unless the caller holds `view_cost_margin`.
   - CSV export requires `export_reports` special permission and escapes all formula injection vectors (`=`, `+`, `-`, `@`) with a leading `'`.

## Go-live checklist

- Before importing any real shop data, confirm every role has tradeInLimitCents set.
- Confirm DocumentSequence collection indexes (`tenantId`, `branchId`, `docType`) exist in production MongoDB replica set.

