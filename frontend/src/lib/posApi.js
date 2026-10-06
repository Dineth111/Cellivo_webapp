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

/** fetch() rejects with a TypeError when the request never reached the server. */
export const isNetworkError = (err) =>
  err instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);

