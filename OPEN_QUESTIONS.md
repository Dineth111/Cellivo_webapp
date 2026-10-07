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
28. ~~**PIN lock check is not atomic with the compare.**~~ **Resolved:** each attempt is reserved with one `findOneAndUpdate` before the bcrypt compare (only while unlocked; the 5th sets the lock), so parallel requests get at most 5 compares.

## Go-live checklist

- Before importing any real shop data, confirm every role has tradeInLimitCents set.
