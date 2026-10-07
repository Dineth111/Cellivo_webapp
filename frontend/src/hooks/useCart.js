'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { checkoutSale, isNetworkError } from '../lib/posApi';

const CART_KEY = 'cellivo_pos_cart';
export const OFFLINE_QUEUE_KEY = 'cellivo_offline_checkout_queue';
const FAILED_KEY = 'cellivo_offline_checkout_failed';

// FRS V-13: exact wording.
export const OFFLINE_MESSAGE =
  "You're offline. Your cart is saved and will be sent when the connection returns.";

const EMPTY_CART = {
  lines: [],
  customer: null,
  invoiceDiscountPercent: 0,
  invoiceDiscountAmountCents: 0,
  tradeIn: null, // { imei, modelName, valuationCents }
  notes: '',
};

const newIdempotencyKey = () =>
  globalThis.crypto?.randomUUID
    ? `pos-${globalThis.crypto.randomUUID()}`
    : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const newLineId = () => `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the in-memory state still works for this session
  }
}

// Online status as an external store (no setState inside effects).
function subscribeOnline(cb) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
const getOnline = () => navigator.onLine;
const getServerOnline = () => true;

/** Integer minor units only. A fixed amount wins over a percentage. */
function calculateLine(unitPriceCents, qty, discountPercent = 0, discountAmountCents = 0) {
  const grossCents = Math.round(unitPriceCents * qty);
  let discountCents = 0;
  if (discountAmountCents > 0) discountCents = Math.min(Math.round(discountAmountCents), grossCents);
  else if (discountPercent > 0) discountCents = Math.min(Math.round((grossCents * discountPercent) / 100), grossCents);
  const netCents = grossCents - discountCents;
  return { grossCents, discountCents, netCents, lineTotalCents: netCents };
}

function makeLine(src) {
  const qty = src.imei ? 1 : Math.max(1, parseInt(src.qty, 10) || 1);
  const unitPriceCents = Math.round(Number(src.unitPriceCents) || 0);
  const discountPercent = Number(src.discountPercent) || 0;
  const discountAmountCents = Math.round(Number(src.discountAmountCents) || 0);
  return {
    id: src.id || newLineId(),
    productId: src.productId || null,
    name: src.name || 'Product',
    barcode: src.barcode || '',
    imei: src.imei || null,
    qty,
    unitPriceCents,
    discountPercent,
    discountAmountCents,
    ...calculateLine(unitPriceCents, qty, discountPercent, discountAmountCents),
  };
}

/**
 * Must only be used after mount on the client (the POS page gates on that),
 * because the initial state is read from localStorage.
 */
export function useCart() {
  const [cart, setCart] = useState(() => {
    const saved = readJson(CART_KEY, {});
    return {
      ...EMPTY_CART,
      ...saved,
      lines: Array.isArray(saved.lines) ? saved.lines.map(makeLine) : [],
      idempotencyKey: saved.idempotencyKey || newIdempotencyKey(),
    };
  });
  const [queue, setQueue] = useState(() => readJson(OFFLINE_QUEUE_KEY, []));
  const [failed, setFailed] = useState(() => readJson(FAILED_KEY, []));
  const [synced, setSynced] = useState([]); // invoices created when the queue drained
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const isOnline = useSyncExternalStore(subscribeOnline, getOnline, getServerOnline);
  const drainingRef = useRef(false);

  // Persist the active cart.
  useEffect(() => {
    writeJson(CART_KEY, cart);
  }, [cart]);

  // F9 opens payment, Esc closes it.
  const hasLines = cart.lines.length > 0;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F9') {
        e.preventDefault();
        if (hasLines) setIsPaymentOpen(true);
      } else if (e.key === 'Escape') {
        setIsPaymentOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasLines]);

  // localStorage is the source of truth for the queue so other tabs and reloads see it.
  const updateQueue = useCallback((fn) => {
    const next = fn(readJson(OFFLINE_QUEUE_KEY, []));
    writeJson(OFFLINE_QUEUE_KEY, next);
    setQueue(next);
  }, []);

  const updateFailed = useCallback((fn) => {
    const next = fn(readJson(FAILED_KEY, []));
    writeJson(FAILED_KEY, next);
    setFailed(next);
  }, []);

  /**
   * Sends queued checkouts oldest first, each with its original idempotency key, so a
   * request that did reach the server before the connection dropped returns the same invoice.
   * Stops at the first network error; a server rejection is moved to `failed` for the cashier.
   */
  const drainQueue = useCallback(async () => {
    if (drainingRef.current || !navigator.onLine) return;
    if (readJson(OFFLINE_QUEUE_KEY, []).length === 0) return;
    drainingRef.current = true;
    try {
      for (const entry of readJson(OFFLINE_QUEUE_KEY, [])) {
        try {
          const invoice = await checkoutSale(entry.payload, entry.idempotencyKey);
          updateQueue((q) => q.filter((e) => e.idempotencyKey !== entry.idempotencyKey));
          setSynced((s) => [...s, invoice]);
        } catch (err) {
          if (isNetworkError(err)) break;
          updateQueue((q) => q.filter((e) => e.idempotencyKey !== entry.idempotencyKey));
          updateFailed((f) => [...f, { ...entry, error: err.message }]);
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [updateQueue, updateFailed]);

  // Drain on mount (a queue left from a previous session) and whenever the connection returns.
  useEffect(() => {
    drainQueue();
    window.addEventListener('online', drainQueue);
    return () => window.removeEventListener('online', drainQueue);
  }, [drainQueue]);

  const totals = useMemo(() => {
    let subtotalCents = 0;
    let lineDiscountCents = 0;
    for (const l of cart.lines) {
      subtotalCents += l.grossCents;
      lineDiscountCents += l.discountCents;
    }
    const afterLines = subtotalCents - lineDiscountCents;
    let invoiceDiscountCents = 0;
    if (cart.invoiceDiscountAmountCents > 0) {
      invoiceDiscountCents = Math.min(Math.round(cart.invoiceDiscountAmountCents), afterLines);
    } else if (cart.invoiceDiscountPercent > 0) {
      invoiceDiscountCents = Math.min(Math.round((afterLines * cart.invoiceDiscountPercent) / 100), afterLines);
    }
    const totalDiscountCents = lineDiscountCents + invoiceDiscountCents;
    const tradeInValueCents = cart.tradeIn ? Math.round(cart.tradeIn.valuationCents) || 0 : 0;
    const grandTotalCents = Math.max(0, subtotalCents - totalDiscountCents - tradeInValueCents);
    return { subtotalCents, totalDiscountCents, tradeInValueCents, grandTotalCents };
  }, [cart]);

  const patch = useCallback((changes) => setCart((c) => ({ ...c, ...changes })), []);

  /** Adds a product. IMEI units are always their own line with qty 1. */
  const addProduct = useCallback((product, imei = null) => {
    setCart((c) => {
      if (!imei) {
        const idx = c.lines.findIndex((l) => l.productId === product._id && !l.imei);
        if (idx >= 0) {
          const lines = [...c.lines];
          lines[idx] = makeLine({ ...lines[idx], qty: lines[idx].qty + 1 });
          return { ...c, lines };
        }
      }
      const line = makeLine({
        productId: product._id,
        name: product.name,
        barcode: product.barcode,
        imei,
        qty: 1,
        unitPriceCents: product.sellingPriceCents,
      });
      return { ...c, lines: [...c.lines, line] };
    });
  }, []);

  const updateLineQty = useCallback((lineId, qty) => {
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => (l.id === lineId && !l.imei ? makeLine({ ...l, qty }) : l)),
    }));
  }, []);

  const removeLine = useCallback((lineId) => {
    setCart((c) => ({ ...c, lines: c.lines.filter((l) => l.id !== lineId) }));
  }, []);

  const clearCart = useCallback(() => {
    setCart({ ...EMPTY_CART, idempotencyKey: newIdempotencyKey() });
    setIsPaymentOpen(false);
  }, []);

  /** Replaces the active cart with a held one (lines, customer, discounts, trade-in, notes). */
  const loadHeldCart = useCallback((held) => {
    const d = held?.discounts || {};
    setCart({
      ...EMPTY_CART,
      lines: (held?.lines || []).map((l) => makeLine({ ...l, id: undefined })),
      customer: held?.customer || null,
      invoiceDiscountPercent: Number(d.invoiceDiscountPercent) || 0,
      invoiceDiscountAmountCents: Math.round(Number(d.invoiceDiscountAmountCents) || 0),
      tradeIn: d.tradeIn || null,
      notes: d.notes || '',
      idempotencyKey: newIdempotencyKey(),
    });
  }, []);

  /** Request body for POST /pos/sales/checkout. Cost prices are left to the server. */
  const buildCheckoutPayload = useCallback(
    ({ payments, printReceipt, smsReceipt, installmentPlan, managerPin }) => ({
      customerId: cart.customer?._id || undefined,
      lines: cart.lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        barcode: l.barcode,
        imei: l.imei || undefined,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        discountPercent: l.discountPercent,
        discountAmountCents: l.discountAmountCents,
      })),
      invoiceDiscountPercent: cart.invoiceDiscountPercent,
      invoiceDiscountAmountCents: cart.invoiceDiscountAmountCents,
      tradeInValueCents: totals.tradeInValueCents,
      tradeIn: cart.tradeIn || undefined,
      installmentPlan: installmentPlan || undefined,
      managerPin: managerPin || undefined,
      payments,
      notes: cart.notes || undefined,
      printReceipt,
      smsReceipt,
    }),
    [cart, totals.tradeInValueCents]
  );

  /**
   * Online: sends the sale. Offline, or if the request never reached the server: queues it
   * with this cart's idempotency key and starts a fresh cart.
   * Returns { invoice } or { queued: true }. Server rejections are thrown to the caller.
   */
  const submitCheckout = useCallback(
    async (options) => {
      const payload = buildCheckoutPayload(options);
      const key = cart.idempotencyKey;
      const enqueue = () => {
        updateQueue((q) =>
          q.some((e) => e.idempotencyKey === key)
            ? q
            : [...q, { idempotencyKey: key, payload, queuedAt: new Date().toISOString() }]
        );
        clearCart();
        return { queued: true };
      };

      if (!navigator.onLine) return enqueue();
      try {
        const invoice = await checkoutSale(payload, key);
        clearCart();
        return { invoice };
      } catch (err) {
        if (isNetworkError(err)) return enqueue();
        throw err;
      }
    },
    [buildCheckoutPayload, cart.idempotencyKey, updateQueue, clearCart]
  );

  const dismissFailed = useCallback(
    (key) => updateFailed((f) => f.filter((e) => e.idempotencyKey !== key)),
    [updateFailed]
  );
  const dismissSynced = useCallback(() => setSynced([]), []);

  return {
    lines: cart.lines,
    customer: cart.customer,
    setCustomer: (customer) => patch({ customer }),
    invoiceDiscountPercent: cart.invoiceDiscountPercent,
    setInvoiceDiscountPercent: (invoiceDiscountPercent) =>
      patch({ invoiceDiscountPercent, invoiceDiscountAmountCents: 0 }),
    invoiceDiscountAmountCents: cart.invoiceDiscountAmountCents,
    tradeIn: cart.tradeIn,
    setTradeIn: (tradeIn) => patch({ tradeIn }),
    notes: cart.notes,
    setNotes: (notes) => patch({ notes }),
    totals,
    isPaymentOpen,
    setIsPaymentOpen,
    isOnline,
    addProduct,
    updateLineQty,
    removeLine,
    clearCart,
    loadHeldCart,
    submitCheckout,
    queue,
    failed,
    dismissFailed,
    synced,
    dismissSynced,
  };
}

export default useCart;
