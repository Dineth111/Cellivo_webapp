import { authFetch } from './api.js';

/**
 * Stock records come back from the backend with `qty` and an `imeiList`.
 * The POS screens work with one flat shape, so normalise here.
 */
export function normalizeProduct(p) {
  if (!p) return null;
  const imeiList = Array.isArray(p.imeiList) ? p.imeiList : [];
  const requiresImei = imeiList.length > 0;
  const availableImeis = imeiList.filter((i) => i.status === 'in_stock').map((i) => i.imei);
  return {
    _id: p._id,
    name: p.name,
    barcode: p.barcode || '',
    category: p.category || 'General',
    sellingPriceCents: Number(p.sellingPriceCents) || 0,
    requiresImei,
    availableImeis,
    stock: requiresImei ? availableImeis.length : Number(p.qty) || 0,
  };
}

/** Free-text product search (name, brand or barcode). */
export async function searchProducts(q) {
  const res = await authFetch(`/pos/sales/items/lookup?q=${encodeURIComponent(q)}`);
  return (res.data || []).map(normalizeProduct);
}

/** Exact barcode match, or null. */
export async function lookupBarcode(barcode) {
  const res = await authFetch(`/pos/sales/items/lookup?barcode=${encodeURIComponent(barcode)}`);
  return normalizeProduct(res.data);
}

/** Exact IMEI match: { product, imeiStatus } or null. */
export async function lookupImei(imei) {
  const res = await authFetch(`/pos/sales/items/lookup?imei=${encodeURIComponent(imei)}`);
  if (!res.data) return null;
  return { product: normalizeProduct(res.data.product), imeiStatus: res.data.imeiItem?.status || null };
}

/**
 * Completes a checkout. The idempotency key is sent both as a header and in the body
 * so a retried request (e.g. from the offline queue) never creates a second invoice.
 */
export async function checkoutSale(saleData, idempotencyKey) {
  const res = await authFetch('/pos/sales/checkout', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    body: JSON.stringify({ ...saleData, idempotencyKey }),
  });
  return res.data;
}

/** Holds a cart. Body shape matches POST /cart/hold: { cartName, customer, lines, discounts }. */
export async function holdCart(cartData) {
  const res = await authFetch('/pos/sales/cart/hold', {
    method: 'POST',
    body: JSON.stringify(cartData),
  });
  return res.data;
}

export async function getHeldCarts() {
  const res = await authFetch('/pos/sales/cart/held');
  return res.data || [];
}

/** Resumes (and removes) a held cart; returns the stored cart document. */
export async function resumeCart(id) {
  const res = await authFetch(`/pos/sales/cart/resume/${id}`, { method: 'POST' });
  return res.data;
}

export async function getCustomers() {
  const res = await authFetch('/customers');
  return res.data || [];
}

/** Fetches invoice details with lines, payments, and branch metadata by ID. */
export async function getInvoiceById(id) {
  const res = await authFetch(`/pos/sales/invoices/${id}`);
  return res.data;
}

/**
 * Looks up an invoice for return and calculates eligible items/quantities.
 */
export async function lookupReturnInvoice(invoiceNumber) {
  const res = await authFetch(`/pos/returns/lookup/${encodeURIComponent(invoiceNumber)}`);
  return res.data;
}

/**
 * Processes a return and generates a CreditNote.
 */
export async function processReturn(returnData) {
  const res = await authFetch('/pos/returns', {
    method: 'POST',
    body: JSON.stringify(returnData),
  });
  return res.data;
}

/**
 * Processes an atomic exchange combining return and new purchase.
 */
export async function processExchange(exchangeData) {
  const res = await authFetch('/pos/returns/exchange', {
    method: 'POST',
    body: JSON.stringify(exchangeData),
  });
  return res.data;
}

/** fetch() rejects with a TypeError when the request never reached the server. */
export const isNetworkError = (err) =>
  err instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);

/**
 * Checks customer credit limit and exposure eligibility.
 * With a manager PIN it POSTs instead, so the PIN never ends up in a URL.
 */
export async function checkCreditEligibility(customerId, requestedAmountCents = 0, pin = null) {
  const url = `/pos/credit/customers/${encodeURIComponent(customerId)}/eligibility`;
  const res = pin
    ? await authFetch(url, { method: 'POST', body: JSON.stringify({ pin, amountCents: requestedAmountCents }) })
    : await authFetch(`${url}?requestedAmountCents=${requestedAmountCents}`);
  return res.data;
}

/**
 * Retrieves customer aging summary and overdue installments.
 */
export async function getCustomerAging(customerId) {
  const res = await authFetch(`/pos/credit/customers/${encodeURIComponent(customerId)}/aging`);
  return res.data;
}

/**
 * Records a customer collection payment applied oldest-due first.
 */
export async function recordCreditPayment(paymentData) {
  const res = await authFetch('/pos/credit/payments', {
    method: 'POST',
    body: JSON.stringify(paymentData),
  });
  return res.data;
}

/**
 * Retrieves all overdue installments across the branch.
 */
export async function getOverdueInstallments() {
  const res = await authFetch('/pos/credit/overdue');
  return res.data || [];
}

/**
 * Dispatches an automated installment SMS reminder.
 */
export async function sendInstallmentReminder(planId, installmentNo) {
  const res = await authFetch(`/pos/credit/remind/${encodeURIComponent(planId)}/${encodeURIComponent(installmentNo)}`, {
    method: 'POST',
  });
  return res.data;
}

/**
 * Previews installment schedule without saving.
 */
export async function calculateInstallmentSchedule(scheduleParams) {
  const res = await authFetch('/pos/credit/calculate-schedule', {
    method: 'POST',
    body: JSON.stringify(scheduleParams),
  });
  return res.data;
}

// -------------------------------------------------------------
// Phase 7: Cash Drawer and Finance API
// -------------------------------------------------------------

/**
 * Gets active open cash drawer session for the cashier.
 */
export async function getCurrentDrawerSession() {
  const res = await authFetch('/pos/finance/drawer/current');
  return res.data;
}

/**
 * Opens a new cash drawer session.
 */
export async function openDrawerSession(floatCents = 0, terminalId = 'terminal-1') {
  const res = await authFetch('/pos/finance/drawer/open', {
    method: 'POST',
    body: JSON.stringify({ openingFloatCents: floatCents, terminalId }),
  });
  return res.data;
}

/**
 * Records a cash movement (cash_in / cash_out).
 */
export async function recordCashMovement(movementData) {
  const res = await authFetch('/pos/finance/drawer/movement', {
    method: 'POST',
    body: JSON.stringify(movementData),
  });
  return res.data;
}

/**
 * Closes the drawer session with denomination breakdown and optional manager PIN.
 */
export async function closeDrawerSession(closeData) {
  const res = await authFetch('/pos/finance/drawer/close', {
    method: 'POST',
    body: JSON.stringify(closeData),
  });
  return res.data;
}

/**
 * Retrieves the Z-Report for a closed session.
 */
export async function getZReport(sessionId) {
  const res = await authFetch(`/pos/finance/drawer/z-report/${encodeURIComponent(sessionId)}`);
  return res.data;
}

/**
 * Retrieves the day-end finance reconciliation summary.
 */
export async function getDayEndReport(date = null) {
  const url = date ? `/pos/finance/day-end?date=${encodeURIComponent(date)}` : '/pos/finance/day-end';
  const res = await authFetch(url);
  return res.data;
}

/**
 * Retrieves customer loyalty point balance and transaction history.
 */
export async function getCustomerLoyalty(customerId) {
  const res = await authFetch(`/pos/loyalty/customer/${encodeURIComponent(customerId)}`);
  return res.data;
}

/**
 * Calculates discount and remaining balance for requested loyalty points redemption.
 */
export async function calculateLoyaltyRedemption(points) {
  const res = await authFetch('/pos/loyalty/calculate-redemption', {
    method: 'POST',
    body: JSON.stringify({ points }),
  });
  return res.data;
}



