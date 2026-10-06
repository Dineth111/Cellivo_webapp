import { authFetch } from './api.js';

/**
 * Looks up inventory items by barcode, IMEI, or text query.
 */
export async function lookupItems({ barcode, imei, q }) {
  const params = new URLSearchParams();
  if (barcode) params.set('barcode', barcode);
  if (imei) params.set('imei', imei);
  if (q) params.set('q', q);

  const res = await authFetch(`/pos/sales/items/lookup?${params.toString()}`);
  return res.data;
}

/**
 * Calculates cart line items, discounts, taxes, and trade-in totals.
 */
export async function calculateCart(cartData) {
  const res = await authFetch('/pos/sales/cart/calculate', {
    method: 'POST',
    body: JSON.stringify(cartData),
  });
  return res.data;
}

/**
 * Completes a checkout transaction idempotently.
 */
export async function checkoutSale(saleData, idempotencyKey = null) {
  const headers = {};
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const res = await authFetch('/pos/sales/checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify(saleData),
  });
  return res.data;
}

/**
 * Holds the current cart.
 */
export async function holdCart(cartData) {
  const res = await authFetch('/pos/sales/cart/hold', {
    method: 'POST',
    body: JSON.stringify(cartData),
  });
  return res.data;
}

/**
 * Fetches active held carts.
 */
export async function getHeldCarts() {
  const res = await authFetch('/pos/sales/cart/held');
  return res.data || [];
}

/**
 * Resumes and removes a held cart.
 */
export async function resumeCart(id) {
  const res = await authFetch(`/pos/sales/cart/resume/${id}`, {
    method: 'POST',
  });
  return res.data;
}

/**
 * Fetches tenant customers for customer search.
 */
export async function getCustomers(search = '') {
  try {
    const res = await authFetch('/customers');
    const list = res.data || [];
    if (!search) return list;
    const lower = search.toLowerCase();
    return list.filter(
      (c) =>
        c.name?.toLowerCase().includes(lower) ||
        c.phone?.includes(search) ||
        c.email?.toLowerCase().includes(lower)
    );
  } catch {
    return [];
  }
}

export default {
  lookupItems,
  calculateCart,
  checkoutSale,
  holdCart,
  getHeldCarts,
  resumeCart,
  getCustomers,
};
