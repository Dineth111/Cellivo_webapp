'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

const CART_STORAGE_KEY = 'cellivo_pos_cart';

export const OFFLINE_MESSAGE =
  "You're offline. Your cart is saved and will be sent when the connection returns.";

/**
 * Generates an idempotency key for the active checkout session.
 */
function createIdempotencyKey() {
  return `pos-idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Integer minor units rounding and math.
 */
function round(n) {
  return Math.round(Number(n) || 0);
}

function calculateLine(unitPriceCents, qty, discountPercent = 0, discountAmountCents = 0) {
  const grossCents = round(unitPriceCents * qty);
  let discountCents = 0;
  if (discountAmountCents > 0) {
    discountCents = Math.min(round(discountAmountCents), grossCents);
  } else if (discountPercent > 0) {
    discountCents = Math.min(Math.round((grossCents * Number(discountPercent)) / 100), grossCents);
  }
  const netCents = Math.max(0, grossCents - discountCents);
  return { grossCents, discountCents, netCents, lineTotalCents: netCents };
}

export function useCart() {
  const [lines, setLines] = useState([]);
  const [customer, setCustomer] = useState(null); // null = walk-in
  const [invoiceDiscountPercent, setInvoiceDiscountPercent] = useState(0);
  const [invoiceDiscountAmountCents, setInvoiceDiscountAmountCents] = useState(0);
  const [tradeIn, setTradeIn] = useState(null); // { imei, modelName, valuationCents }
  const [notes, setNotes] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // 1. Load initial cart from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(CART_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.lines)) setLines(parsed.lines);
        if (parsed.customer) setCustomer(parsed.customer);
        if (parsed.invoiceDiscountPercent) setInvoiceDiscountPercent(parsed.invoiceDiscountPercent);
        if (parsed.invoiceDiscountAmountCents) setInvoiceDiscountAmountCents(parsed.invoiceDiscountAmountCents);
        if (parsed.tradeIn) setTradeIn(parsed.tradeIn);
        if (parsed.notes) setNotes(parsed.notes);
        if (parsed.idempotencyKey) setIdempotencyKey(parsed.idempotencyKey);
      }
    } catch (e) {
      console.warn('Failed to restore cart from localStorage', e);
    }
  }, []);

  // 2. Persist cart to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const payload = {
        lines,
        customer,
        invoiceDiscountPercent,
        invoiceDiscountAmountCents,
        tradeIn,
        notes,
        idempotencyKey,
      };
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save cart to localStorage', e);
    }
  }, [lines, customer, invoiceDiscountPercent, invoiceDiscountAmountCents, tradeIn, notes, idempotencyKey]);

  // 3. Monitor online / offline status
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 4. Global keyboard shortcuts (F9 opens Payment modal, Esc closes it)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'F9') {
        e.preventDefault();
        if (lines.length > 0) {
          setIsPaymentOpen(true);
        }
      } else if (e.key === 'Escape' && isPaymentOpen) {
        e.preventDefault();
        setIsPaymentOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lines.length, isPaymentOpen]);

  // 5. Real-time Totals calculation (minor units)
  const totals = useMemo(() => {
    let subtotalCents = 0;
    let totalLineDiscountsCents = 0;

    for (const l of lines) {
      subtotalCents += l.grossCents;
      totalLineDiscountsCents += l.discountCents;
    }

    const netBeforeInvoiceDiscount = Math.max(0, subtotalCents - totalLineDiscountsCents);

    let invoiceDiscountCents = 0;
    if (invoiceDiscountAmountCents > 0) {
      invoiceDiscountCents = Math.min(round(invoiceDiscountAmountCents), netBeforeInvoiceDiscount);
    } else if (invoiceDiscountPercent > 0) {
      invoiceDiscountCents = Math.min(
        Math.round((netBeforeInvoiceDiscount * Number(invoiceDiscountPercent)) / 100),
        netBeforeInvoiceDiscount
      );
    }

    const totalDiscountCents = totalLineDiscountsCents + invoiceDiscountCents;
    const netAfterDiscount = Math.max(0, subtotalCents - totalDiscountCents);

    const tradeInValueCents = tradeIn ? round(tradeIn.valuationCents) : 0;
    const grandTotalCents = Math.max(0, netAfterDiscount - tradeInValueCents);

    return {
      subtotalCents,
      totalLineDiscountsCents,
      invoiceDiscountCents,
      totalDiscountCents,
      tradeInValueCents,
      grandTotalCents,
    };
  }, [lines, invoiceDiscountPercent, invoiceDiscountAmountCents, tradeIn]);

  // 6. Cart Item Actions
  const addProduct = useCallback((product, selectedImei = null) => {
    setLines((prev) => {
      // If IMEI is provided, it's a unique single-unit line
      if (selectedImei) {
        const lineCalc = calculateLine(product.sellingPriceCents, 1, 0, 0);
        return [
          ...prev,
          {
            id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            productId: product._id,
            name: product.name,
            barcode: product.barcode,
            imei: selectedImei,
            qty: 1,
            unitPriceCents: product.sellingPriceCents,
            costPriceCents: product.costPriceCents || 0,
            discountPercent: 0,
            discountAmountCents: 0,
            ...lineCalc,
          },
        ];
      }

      // Check if item already exists without an IMEI
      const existingIdx = prev.findIndex(
        (l) => l.productId === product._id && !l.imei && l.barcode === product.barcode
      );

      if (existingIdx >= 0) {
        const updated = [...prev];
        const existing = updated[existingIdx];
        const newQty = existing.qty + 1;
        const lineCalc = calculateLine(
          existing.unitPriceCents,
          newQty,
          existing.discountPercent,
          existing.discountAmountCents
        );
        updated[existingIdx] = {
          ...existing,
          qty: newQty,
          ...lineCalc,
        };
        return updated;
      }

      // Add fresh line
      const lineCalc = calculateLine(product.sellingPriceCents, 1, 0, 0);
      return [
        ...prev,
        {
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          productId: product._id,
          name: product.name,
          barcode: product.barcode,
          imei: null,
          qty: 1,
          unitPriceCents: product.sellingPriceCents,
          costPriceCents: product.costPriceCents || 0,
          discountPercent: 0,
          discountAmountCents: 0,
          ...lineCalc,
        },
      ];
    });
  }, []);

  const updateLineQty = useCallback((lineId, newQty) => {
    const q = Math.max(1, parseInt(newQty, 10) || 1);
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        // Cannot change qty on IMEI items
        if (l.imei) return l;
        const lineCalc = calculateLine(l.unitPriceCents, q, l.discountPercent, l.discountAmountCents);
        return { ...l, qty: q, ...lineCalc };
      })
    );
  }, []);

  const removeLine = useCallback((lineId) => {
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  }, []);

  const updateLineDiscount = useCallback((lineId, { percent = 0, amountCents = 0 }) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        const lineCalc = calculateLine(l.unitPriceCents, l.qty, percent, amountCents);
        return {
          ...l,
          discountPercent: percent,
          discountAmountCents: amountCents,
          ...lineCalc,
        };
      })
    );
  }, []);

  const clearCart = useCallback(() => {
    setLines([]);
    setCustomer(null);
    setInvoiceDiscountPercent(0);
    setInvoiceDiscountAmountCents(0);
    setTradeIn(null);
    setNotes('');
    setIdempotencyKey(createIdempotencyKey());
    setIsPaymentOpen(false);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(CART_STORAGE_KEY);
    }
  }, []);

  return {
    lines,
    customer,
    setCustomer,
    invoiceDiscountPercent,
    setInvoiceDiscountPercent,
    invoiceDiscountAmountCents,
    setInvoiceDiscountAmountCents,
    tradeIn,
    setTradeIn,
    notes,
    setNotes,
    totals,
    idempotencyKey,
    isPaymentOpen,
    setIsPaymentOpen,
    isOnline,
    offlineNotice: !isOnline ? OFFLINE_MESSAGE : null,
    addProduct,
    updateLineQty,
    removeLine,
    updateLineDiscount,
    clearCart,
  };
}

export default useCart;
