# Handover: Dev 3 to Dev 4

Branch: `feature/F-09-pos-sale` (merge to `main` via PR before you branch: `feature/F-xx-name`). Read first: `dev1-to-dev2.md` and `dev2-to-dev3.md` (the foundation and money rules still apply), `docs/architecture/tenancy.md`, `OPEN_QUESTIONS.md` items 24 to 26.

## Setup

Same as before. `npm test` runs in-memory MongoDB. If `test/helpers.js` cannot find `mongod`, point it at a local binary instead of editing the helper:

```sh
MONGOMS_SYSTEM_BINARY="C:\Users\<you>\.cache\mongodb-binaries\mongod-x64-win32-8.2.6.exe" npx vitest run test/pos.test.js
```

Keep about 1 GB free on the drive that holds your temp folder; MongoDB refuses writes below 500 MB.

## The two things between us

1. **POS needs your stock service.** Until it exists, POS runs on a stand-in: `modules/pos/adapters/stock.adapter.js` over a fake `FakeStock` model. Both are marked `TEMP: replace with Developer 4's service`.
2. **Purchasing posts money through my ledger.** `modules/pos/services/ledger.service.js` is ready to use.

## 1. Stock: the contract POS depends on

Replace the body of each function in `stock.adapter.js` with a call to your service and **keep the signatures, return shapes and error codes**. Then nothing in POS changes. Every function is tenant- and branch-scoped. Every write takes a Mongo `session` and must use it, because POS runs the sale (invoice, payments, stock, ledger) as one transaction and retries on `TransientTransactionError`.

| Function | Called from | What POS relies on |
|---|---|---|
| `lookupByBarcode(tenantId, branchId, barcode)` | sale lookup, checkout | Product with `name`, `barcode`, `sellingPriceCents`, `wholesalePriceCents`, `costPriceCents`, `qty`, or `null` |
| `lookupImei(tenantId, branchId, imei)` | sale lookup, checkout | `{ product, imeiItem }` or `null`; POS reads `.product` |
| `searchProducts(tenantId, branchId, query)` | item search | Max 50 results. The query is user text: escape it (`escapeRegex` in `core/validate.js`) and reject over 100 chars |
| `deductStock(tenantId, branchId, imeiOrBarcode, qty, session)` | checkout | Tries IMEI first, then barcode. Marks the IMEI `sold`. Throws `400 V-05` with the FRS text `Only N left at this branch. Reduce the quantity or transfer stock.` |
| `restockReturn(tenantId, branchId, imeiOrBarcode, qty, session)` | return, void | IMEI back to `in_stock`; barcode `qty += qty` |
| `addTradeIn(tenantId, branchId, { imei, modelName, condition, brand, valuationCents }, session)` | checkout with trade-in | Adds the device at cost = valuation. **Must return the stock record**: POS saves its `barcode` on the invoice (`tradeInDevice`) |
| `removeTradeIn(tenantId, branchId, imeiOrBarcode, session)` | void of a trade-in sale | Takes the device back out. If it was already sold on, throws `400 CANNOT_VOID_TRADEIN_SOLD` |
| `reserveImei(tenantId, branchId, imei, minutes)` / `releaseImei(...)` | held carts | 15-minute hold. A job in `server.js` cleans expired held carts every 15 minutes and calls `releaseImei` |

`getCost` is no longer called by POS; drop it.

Rules behind the contract:

- **Price and cost are read from stock on the server, never trusted from the client.** A sale at a price different from `sellingPriceCents` (or `wholesalePriceCents` for wholesale customers) needs `override_price` or a manager PIN. So your lookups are a security boundary: return the real prices.
- IMEI statuses POS uses: `in_stock`, `reserved`, `sold`. Your model can have more (for example `in_transit`), but lookups must not return a unit as sellable unless it is `in_stock` or reserved for this sale.
- POS also blocks selling an IMEI that is on any active invoice (`V-03`). Keep the IMEI unique per tenant on your side too.

### When you swap it in

- Delete `models/FakeStock.model.js` and replace its entry in `test/isolation.test.js` with your own stock models.
- Tests seed `FakeStock` directly in `pos`, `returns`, `credit`, `loyalty` and `finance` tests (`setupShop` / `setupReturnShop`). Give them one seeding helper from your module and swap the imports.
- Stock transfers between branches should use the same branch check as POS: `resolveBranch(req)` in `modules/pos/utils/branch.js`. It returns 403 unless the user is assigned to the branch or has `view_all_branches`, and 404 if the branch is not in this tenant. Use `resolveRecordBranch(req, Model, id)` for routes that load an existing record. Move it to `core` with Dev 1 if you want it shared.
- `test/api.js` has `addBranch(tenantId, { invoicePrefix, userIds })` to create a second branch in tests.

## 2. Ledger: how purchasing posts money

Only the ledger posts money. Call the service in-process, inside your own transaction:

```js
import * as ledgerService from '../pos/services/ledger.service.js';

await ledgerService.postJournal({
  tenantId, branchId,
  referenceType: 'manual',          // see open item below
  referenceId: grn.number,           // shows on reports; also used to find entries to reverse
  description: `GRN ${grn.number} from ${supplier.name}`,
  lines: [
    { accountCode: '1050', debit: totalCents, credit: 0 },   // Inventory
    { accountCode: '1010', debit: 0, credit: totalCents },   // paid from Cash
  ],
  createdBy: userId,
  session,
});
```

- Integer cents only. Debits must equal credits and be > 0, or it throws `400 UNBALANCED_JOURNAL`.
- To map a payment method to an account, use `ledgerService.accountForMethod(method)`: cash 1010, card 1020, bank_transfer / bank / cheque 1030, credit 1040, store_credit 2020, loyalty_points 2030. Unknown methods throw `INVALID_PAYMENT_METHOD`.
- To undo an entry, use `postVoidReversal({ tenantId, originalEntryNumber, reason, createdBy, session })`. It never deletes.
- Chart of accounts: 1010 Cash, 1020 Card clearing, 1030 Bank, 1040 Receivable, 1050 Inventory, 2010 Tax payable, 2020 Store credit, 2030 Loyalty liability, 4010 Sales, 4020 Other income, 4030 Sales returns, 5010 COGS, 5020 Expenses.
- An HTTP route also exists: `POST /api/pos/ledger/journal`. It needs `finance.create`, posts to the request's branch, and is audited as `ledger.manual_journal`. Use it only from outside the backend; from your own code, call the service with your `session` so stock and money commit together.

## Open items that affect you

- **No Accounts Payable account and no `purchase` reference type.** Purchasing on supplier credit needs a payable (for example `2040 Accounts payable`). `LedgerEntry.referenceType` only allows `sale, payment, refund, credit_sale, installment, trade_in, void, manual`. Tell me which you need and I will add both. Until then, post as `manual`.
- **Trade-in stock** is created by `addTradeIn` with barcode `TRADEIN-<imei>` and category `Trade-in`. Decide how your product catalogue wants these (a real product per model, or a generic used-device product) and tell me if the input to `addTradeIn` must change.
- **Reservations on sale.** `deductStock` currently sells an IMEI even if another cart has it reserved. Your service should refuse unless the reservation belongs to this sale; POS will pass a cart id if you need one.
- **Low-stock alerts** go through Dev 5's notification service, not POS.

## Contacts

Ledger accounts, reference types or journal rules: me (Dev 3). Tenant isolation, `requirePermission`, audit and moving `resolveBranch` into core: Dev 1. Plan feature flags for inventory or purchasing: Dev 2.
