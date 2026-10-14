# Open questions and decisions taken (Dev 1 foundation)

Each item states the safe default that was implemented. Confirm or change.

## Product / policy

1. **Email uniqueness.** Login has no tenant field, so email is unique across the whole platform (FRS F-01 says so; F-04 says "unique within tenant"). The same person cannot be staff in two shops. Confirm.
2. **Registration message.** A duplicate email returns the FRS text "An account with this email already exists...", which reveals that the email is registered. Login and forgot-password do not reveal it. Confirm whether sign-up may reveal it.
3. **Default role grids** come from SRS Appendix B and Figure 10.17. Not specified there, so guessed: Purchases (manager view/create/edit, accountant view/create/edit), Customers (manager view/create/edit, accountant view), Branches (manager and accountant view), Settings (manager view/edit), discount limits (manager 20%, cashier 5%, others 0%), `override_price` and `view_all_branches` for owner only. Technician cannot see customers.
4. **Owner multiplicity.** More than one owner is allowed; the last active owner cannot be deactivated or demoted.
5. **Deactivated / locked users** get the same generic login message as a wrong password, so they are not told why. Support needs another channel to explain.
6. **Lockout notice to the owner** is only a TODO (needs Dev 5's notification service).
7. **Suspended tenants.** FRS F-02 says a suspended tenant may only reach Billing. The tenant status is in the request context (`tenantStatus`) but nothing enforces it yet. Belongs with Dev 2's billing.
8. **Custom roles are a Starter+ feature** (FRS F-04). Not enforced; needs Dev 2's plan-limit service (TODO in roles controller).
9. **Currency by country.** New tenants get LKR and Asia/Colombo regardless of country.
10. **Tenant idle timeout** (10 to 240 min) is stored on Tenant but there is no settings endpoint yet (F-19 settings screen).
11. ~~**Approval PIN** verify endpoint.~~ **Resolved:** `POST /api/users/verify-pin` built with item 25.

## Security / technical

12. **Not built (stubs by request):** 2FA, IP allow-list, device approval (SEC-03, 06, 07). No code exists for them yet.
13. **Refresh token storage.** Tokens go in the JSON body and the frontend keeps them in localStorage/sessionStorage. httpOnly cookies would be safer against XSS but need CSRF protection and a same-site deployment. Decide before launch.
14. **Refresh token reuse detection** is simple: a replayed old token just fails. It does not revoke the whole session.
15. **Idle timeout precision** is about one minute (`lastSeenAt` is written at most once a minute).
16. **Audit writes never fail the request** (errors are logged). If a stricter "no audit, no action" rule is wanted, change `core/audit.js`.
17. **Audit is append-only in the application only.** A database user with write access can still change it. For SEC-09 in production, give the app a MongoDB role without update/delete on `auditlogs`.
18. **Existing data.** Users and customers created before this change have no `tenantId`, no role and a different password field, so they are invisible / cannot log in. The Atlas database was not touched. Either drop them or write a one-off migration. `npm run seed` creates a fresh demo shop (`owner@cellivo.lk` ... password `Cellivo@123`).
19. **`AuditLog`, `Session` and `User` grow without limit.** No TTL / archiving yet.
20. **Transactions** need a replica set. Atlas is one; a local standalone `mongod` is not (tests use an in-memory replica set).
21. **Branches endpoint** is read-only. Create/edit with the plan limit (BR-01) is not built yet.
22. **Aggregations using `$geoNear` or `$search`** cannot go through the tenant plugin (they must be the first stage). See docs/architecture/tenancy.md.
23. **Line endings.** The repo mixes CRLF and LF (Windows). Consider a `.gitattributes` with `* text=auto eol=lf`.

## POS review fixes (Dev 3)

24. ~~**Trade-in limit per role.**~~ **Resolved:** `Role.tradeInLimitCents` added, editable in the roles API (whole cents, 0 or more). **Assumption:** default roles get branch manager Rs 50,000 (5,000,000 cents), every other role 0; the owner has no limit.
25. ~~**Approval PIN lockout is in memory.**~~ **Resolved:** `users.service verifyApprovalPin` + `POST /api/users/verify-pin`; the lockout (5 wrong PINs in 15 min -> locked 15 min, 429 `PIN_LOCKED`) is stored on the requesting user and audited (`pin.verify_failed`, `pin.locked`). The POS adapter calls it.
26. ~~**PIN in a query string.**~~ **Resolved:** the GET eligibility check ignores any PIN; the PIN-checked variant is `POST /api/pos/credit/customers/:id/eligibility { pin, amountCents }`. Frontend `posApi.js` updated.
27. ~~**Existing tenants' roles.**~~ **Resolved, no migration:** there are no production tenants yet; existing data is dev/test only and gets the new defaults from a re-seed. See the go-live checklist.
28: ~~**PIN lock check is not atomic with the compare.**~~ **Resolved:** each attempt is reserved with one `findOneAndUpdate` before the bcrypt compare (only while unlocked; the 5th sets the lock), so parallel requests get at most 5 compares.

## Inventory, IMEI, Purchasing & WooCommerce review fixes (Dev 4)

29. **DocumentSequence concurrency under MongoDB transactions:** Per-branch atomic counters for GRN, PO, BIL, Supplier Payment, and Purchase Return numbers run inside multi-document transactions with an automatic backoff retry loop (`executeWithSession` / `session.withTransaction`) to handle MongoDB `WriteConflict` / `TransientTransactionError` (code 112) under high parallel load.
30. **Stock count missing & unknown IMEIs:** During stock count approval, variance is dynamically recomputed against live `StockLevel.qty`. Missing scanned serial units are transitioned to `written_off` via `transitionStatus` (reducing stock and posting Dr 5040 / Cr 1050). Unknown scanned IMEIs are recorded in `unknownImeis` response list and never auto-created into inventory.
31. **Zero-value GRN ledger entries:** GRNs with total cost 0 update inventory counts but bypass `ledgerService.postJournal` and `SupplierPayment` creation (which strictly requires `amountCents >= 1`).
32. **Cash GRN with no open session:** Cash GRNs record a cash-out via `financeService.recordCashOut` using reason `GRN <documentNumber>`. If the receiving user does not have an open cash drawer session at that branch, the cash-out will be refused by `financeService`. Confirm whether cash GRNs without an open cashier shift should block receipt or allow a ledger-only fallback.
33. **Post-commit low-stock alerts:** Low-stock threshold evaluations hook into `session.commitTransaction` and dispatch alerts only after the database transaction successfully commits, preventing phantom alerts on rolled back transactions.

## Customers review (Dev 5)

34. **Customer schema additions.** Added `tags` (`[String]`, max 50 chars per tag), `marketingOptIn` (`Boolean`, default `false`), and `mergedInto` (`ObjectId`, ref `Customer`, default `null`). Existing financial metrics (`creditLimitCents`, `currentBalanceCents`, `loyaltyPoints`) remain intact. Normalisation is write-only with no Mongoose getter to prevent accidental display mutations.
35. **LoyaltySettings model & isolation.** Created tenant-scoped `LoyaltySettings` (`pointsPerHundredRupees`, `valuePerPointCents`, `minRedemptionPoints`, `expiryDays`). Enforces tenant isolation via `tenantPlugin`. In `loyaltySettings.adapter.js`, the query is safely wrapped with `runWithContext({ tenantId })` to provide safe defaults for POS functions (e.g. `calculateEarnedPoints`) invoked outside request context.
36. **Merge reference reassignment.** Merge is atomic within a MongoDB transaction session and owner-only. Reassigns `Invoice`, `CreditNote`, `InstallmentPlan`, `LoyaltyTransaction`, `Quotation`, and `Cheque`. Specifically:
   - Does NOT change `customerSnapshot` on `Invoice` documents, preserving historical customer details at time of sale.
   - Does NOT touch `LedgerEntry` records (Dev 3's financial ledger remains an immutable double-entry log).
   - Skips `HeldCart` (in-progress transient carts are discarded or left to expire).
   - Self-merges, merges into archived/merged customers, circular merges, and cross-tenant merges are rejected with 400 or 404.
37. **Customer history scope.**
   `GET /api/customers/:id/history` returns invoices, payments, returns / credit notes, installment plans and loyalty transactions.
   Repairs (my Phase 3) and devices owned (Dev 4 inventory) return empty arrays until those modules exist.
   Cost prices on invoice lines are masked through `maskCostMargins` unless the caller has the `view_cost_margin` special permission.

### For Dev 3

38. **`reassign.adapter.js` (customers/adapters) is marked TEMP.**
   During a customer merge it writes `customerId` on Invoice, CreditNote, InstallmentPlan, LoyaltyTransaction, Quotation and Cheque inside the merge transaction session.
   It does NOT touch `customerSnapshot` or `LedgerEntry`.
   Dev 3 should either approve this adapter or take ownership of the function.

39. **`completeSale` retry counter mismatch and flaky POS concurrency test.**
   In `pos/services/sale.service.js`, the while loop condition is `while (attempts < 5)` at line 373, but the transient error catch block checks `attempts < 10` at line 553. When transient errors occur under parallel load, `attempts` can reach 5, causing the loop to exit without assigning `createdInvoice` and leading to `TypeError: Cannot read properties of undefined (reading '_id')` at `sale.service.js:562` (HTTP 500).
   This causes `test/pos.test.js` ("guarantees atomic concurrency and gapless sequential numbering") to fail intermittently with a 500 status on `origin/main` (and feature branches). Dev 3 / Dev 4 should align the loop condition with the retry limit.

### For Dev 1

40. **`LoyaltySettings` unique-tenantId index.**
   `LoyaltySettings` makes `tenantId` unique with `schema.path('tenantId')._index = { unique: true }` (private Mongoose field).
   This is necessary because `tenantPlugin` already registers a non-unique `tenantId_1` index via `index: true` on the path, and calling `schema.index({ tenantId: 1 }, { unique: true })` would create a second index definition under the same auto-generated name, causing a MongoDB `createIndex` error at startup.
   Suggest `tenantPlugin` accepts a `{ unique: true }` option so one-per-tenant models do not need the private API.
   An isolation test (`isolation.test.js`, "LoyaltySettings schema constraints") guards the index — it asserts exactly one `{ tenantId: 1 }` index exists, it is unique, and a duplicate insert is rejected with `code 11000`.

41. **Existing phone data and E.164 migration.**
   All new writes store phones in E.164 format (`+94771234567`).
   Reads (duplicate check, search, CSV import) use `phoneVariants()` to match legacy formats still in the database (e.g. `0771234567`, `94771234567`).
   `npm run normalize-phones` is a one-off script (dry-run by default, `--apply` to commit) that should be run once per environment before go-live to convert all stored phones to E.164.
   After that run, `phoneVariants` is still used defensively but should no longer find mismatches.

## Go-live checklist

- Before importing any real shop data, confirm every role has tradeInLimitCents set.
- Confirm DocumentSequence collection indexes (`tenantId`, `branchId`, `docType`) exist in production MongoDB replica set.
