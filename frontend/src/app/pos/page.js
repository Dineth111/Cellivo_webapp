'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  AppHeader,
  Button,
  Badge,
  Alert,
  Spinner,
  money,
} from '../../components/ui';
import PaymentModal from '../../components/pos/PaymentModal';
import useCart from '../../hooks/useCart';
import {
  lookupItems,
  holdCart,
  getHeldCarts,
  resumeCart,
  getCustomers,
} from '../../lib/posApi';
import styles from './pos.module.css';

const CATEGORIES = ['All', 'Phones', 'Accessories', 'Parts', 'Services'];

// Mock items to display if catalog lookup is empty or offline
const SAMPLE_PRODUCTS = [
  {
    _id: 'prod-001',
    name: 'Samsung Galaxy A15 (128GB)',
    category: 'Phones',
    barcode: 'SAM-A15-01',
    sellingPriceCents: 4500000,
    costPriceCents: 3800000,
    requiresImei: true,
    availableImeis: ['359876543210981', '359876543210982'],
    stock: 2,
  },
  {
    _id: 'prod-002',
    name: 'Apple iPhone 15 (128GB)',
    category: 'Phones',
    barcode: 'APL-IP15-128',
    sellingPriceCents: 24500000,
    costPriceCents: 21500000,
    requiresImei: true,
    availableImeis: ['351234567890123'],
    stock: 1,
  },
  {
    _id: 'prod-003',
    name: '20W Fast USB-C Charger',
    category: 'Accessories',
    barcode: 'ACC-CHG-20W',
    sellingPriceCents: 350000,
    costPriceCents: 180000,
    requiresImei: false,
    stock: 24,
  },
  {
    _id: 'prod-004',
    name: 'Tempered Glass Screen Guard',
    category: 'Accessories',
    barcode: 'ACC-SCR-UNIV',
    sellingPriceCents: 120000,
    costPriceCents: 40000,
    requiresImei: false,
    stock: 50,
  },
  {
    _id: 'prod-005',
    name: 'iPhone 13 OLED Screen Replacement',
    category: 'Parts',
    barcode: 'PRT-SCR-IP13',
    sellingPriceCents: 1850000,
    costPriceCents: 1200000,
    requiresImei: false,
    stock: 5,
  },
  {
    _id: 'prod-006',
    name: 'Display Replacement Service',
    category: 'Services',
    barcode: 'SRV-SCR-REP',
    sellingPriceCents: 250000,
    costPriceCents: 0,
    requiresImei: false,
    stock: 999,
  },
];

export default function PosPage() {
  const {
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
    offlineNotice,
    addProduct,
    updateLineQty,
    removeLine,
    updateLineDiscount,
    clearCart,
  } = useCart();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [products, setProducts] = useState(SAMPLE_PRODUCTS);
  const [customers, setCustomers] = useState([]);
  const [heldCarts, setHeldCarts] = useState([]);
  const [isHeldOpen, setIsHeldOpen] = useState(false);
  const [tradeInImei, setTradeInImei] = useState('');
  const [tradeInModel, setTradeInModel] = useState('');
  const [tradeInValuation, setTradeInValuation] = useState('');
  const [successInvoice, setSuccessInvoice] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadingSearch, setLoadingSearch] = useState(false);

  const searchInputRef = useRef(null);

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
    loadCustomers();
  }, []);

  const loadCustomers = async () => {
    try {
      const data = await getCustomers();
      setCustomers(data || []);
    } catch {
      // offline or unauthenticated fallback
    }
  };

  const handleSearchChange = async (e) => {
    const val = e.target.value;
    setSearchQuery(val);

    if (!val.trim()) {
      setProducts(SAMPLE_PRODUCTS);
      return;
    }

    setLoadingSearch(true);
    try {
      const results = await lookupItems({ q: val, barcode: val, imei: val });
      if (results && results.length > 0) {
        setProducts(results);
      } else {
        // Filter local fallback products
        const filtered = SAMPLE_PRODUCTS.filter(
          (p) =>
            p.name.toLowerCase().includes(val.toLowerCase()) ||
            p.barcode?.toLowerCase().includes(val.toLowerCase()) ||
            p.availableImeis?.some((im) => im.includes(val))
        );
        setProducts(filtered);
      }
    } catch {
      const filtered = SAMPLE_PRODUCTS.filter(
        (p) =>
          p.name.toLowerCase().includes(val.toLowerCase()) ||
          p.barcode?.toLowerCase().includes(val.toLowerCase())
      );
      setProducts(filtered);
    } finally {
      setLoadingSearch(false);
    }
  };

  const handleBarcodeSubmit = (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    // Check if barcode or IMEI matches single item directly
    const matched = products.find(
      (p) =>
        p.barcode?.toLowerCase() === searchQuery.trim().toLowerCase() ||
        p.availableImeis?.includes(searchQuery.trim())
    );

    if (matched) {
      if (matched.requiresImei) {
        const foundImei = matched.availableImeis?.find((im) => im === searchQuery.trim()) || matched.availableImeis?.[0];
        addProduct(matched, foundImei);
      } else {
        addProduct(matched);
      }
      setSearchQuery('');
    }
  };

  const handleProductClick = (p) => {
    if (p.requiresImei && p.availableImeis?.length > 0) {
      // Pick first available IMEI not already in cart
      const usedImeis = lines.filter((l) => l.productId === p._id).map((l) => l.imei);
      const available = p.availableImeis.find((im) => !usedImeis.includes(im));
      if (!available) {
        alert('All available IMEI units for this phone are already in the cart!');
        return;
      }
      addProduct(p, available);
    } else {
      addProduct(p);
    }
  };

  const handleApplyTradeIn = () => {
    if (!tradeInModel.trim() || !tradeInValuation) {
      setErrorMsg('Please specify trade-in device model and valuation.');
      return;
    }
    const valCents = Math.round(Number(tradeInValuation) * 100);
    setTradeIn({
      imei: tradeInImei.trim() || undefined,
      modelName: tradeInModel.trim(),
      valuationCents: valCents,
    });
    setTradeInImei('');
    setTradeInModel('');
    setTradeInValuation('');
  };

  const handleHoldCart = async () => {
    if (lines.length === 0) return;
    try {
      await holdCart({
        customerName: customer?.name || 'Walk-in Customer',
        lines,
        invoiceDiscountPercent,
        tradeIn,
        notes,
      });
      clearCart();
      alert('Cart held successfully.');
    } catch (e) {
      setErrorMsg(e.message || 'Failed to hold cart.');
    }
  };

  const handleOpenHeld = async () => {
    setIsHeldOpen(true);
    try {
      const list = await getHeldCarts();
      setHeldCarts(list);
    } catch {
      // offline fallback
    }
  };

  const handleResumeHeld = async (heldId) => {
    try {
      const resumed = await resumeCart(heldId);
      if (resumed) {
        // Load lines from held cart
        clearCart();
        setIsHeldOpen(false);
      }
    } catch (e) {
      setErrorMsg(e.message || 'Failed to resume cart.');
    }
  };

  const handleCheckoutSuccess = (invoice) => {
    setSuccessInvoice(invoice);
    clearCart();
  };

  const filteredProducts = products.filter((p) => {
    if (selectedCategory === 'All') return true;
    return p.category === selectedCategory;
  });

  return (
    <div className={styles.posLayout}>
      {/* AppHeader with online/offline badge and user info */}
      <AppHeader chip="POS Billing">
        <Badge tone={isOnline ? 'success' : 'warning'}>
          {isOnline ? 'Online' : 'Offline Mode'}
        </Badge>
        <Button variant="secondary" onClick={handleOpenHeld}>
          Held Carts
        </Button>
        <Link href="/">
          <Button variant="secondary">Exit POS</Button>
        </Link>
      </AppHeader>

      {/* Offline banner with exact message V-13 */}
      {!isOnline && (
        <div className={styles.offlineBanner}>
          <Alert tone="warning">
            You&apos;re offline. Your cart is saved and will be sent when the connection returns.
          </Alert>
        </div>
      )}

      {errorMsg && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="danger">{errorMsg}</Alert>
        </div>
      )}

      {/* Success Modal / Banner */}
      {successInvoice && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="success">
            <strong>Sale completed!</strong> Invoice #{successInvoice.invoiceNumber} for {money(successInvoice.grandTotalCents)} recorded.
            <Button
              variant="secondary"
              style={{ marginLeft: 12, padding: '4px 10px', minHeight: 32 }}
              onClick={() => setSuccessInvoice(null)}
            >
              Done
            </Button>
          </Alert>
        </div>
      )}

      <main className={styles.posBody}>
        {/* Left: Product Catalog & Barcode Search */}
        <section className={styles.catalogSection}>
          <div className={styles.catalogControls}>
            <form onSubmit={handleBarcodeSubmit} className={styles.searchBar}>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Scan barcode, IMEI, or search products... (Press Enter)"
                className={styles.searchInput}
                value={searchQuery}
                onChange={handleSearchChange}
              />
              <Button type="submit">Search</Button>
            </form>

            <div className={styles.categoryPills}>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`${styles.pillBtn} ${selectedCategory === cat ? styles.pillActive : ''}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {loadingSearch && <Spinner />}

          {/* Product Cards Grid */}
          <div className={styles.productGrid}>
            {filteredProducts.map((p) => (
              <div
                key={p._id}
                className={styles.productCard}
                onClick={() => handleProductClick(p)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => e.key === 'Enter' && handleProductClick(p)}
              >
                <div className={styles.productHeader}>
                  <span className={styles.productCategory}>{p.category}</span>
                  <div className={styles.productName}>{p.name}</div>
                  <div className={styles.productBarcode}>{p.barcode}</div>
                  {p.requiresImei && (
                    <span className={styles.imeiTag}>IMEI Tracked</span>
                  )}
                </div>
                <div className={styles.productFooter}>
                  <div className={styles.productPrice}>
                    {money(p.sellingPriceCents)}
                  </div>
                  <Badge tone={p.stock > 0 ? 'success' : 'danger'}>
                    Stock: {p.stock}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Right: Cart Panel */}
        <aside className={styles.cartSection}>
          <div className={styles.cartHeader}>
            <h2>Current Sale</h2>
            {lines.length > 0 && (
              <Button
                variant="secondary"
                style={{ minHeight: 36, padding: '0 8px', fontSize: '0.8rem' }}
                onClick={clearCart}
              >
                Clear
              </Button>
            )}
          </div>

          {/* Customer selector */}
          <div className={styles.customerPicker}>
            <label style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>
              Customer
            </label>
            <select
              className={styles.customerSelect}
              value={customer?._id || ''}
              onChange={(e) => {
                const c = customers.find((cust) => cust._id === e.target.value);
                setCustomer(c || null);
              }}
            >
              <option value="">Walk-in Customer</option>
              {customers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} ({c.phone || 'No phone'})
                </option>
              ))}
            </select>
          </div>

          {/* Cart Line Items */}
          <div className={styles.cartLines}>
            {lines.length === 0 ? (
              <div className={styles.cartEmpty}>
                <span style={{ fontSize: '2.5rem' }}>🛒</span>
                <p>Your cart is empty.</p>
                <small>Scan barcodes or click products to add items.</small>
              </div>
            ) : (
              lines.map((l) => (
                <div key={l.id} className={styles.lineItem}>
                  <div className={styles.lineTop}>
                    <div className={styles.lineName}>
                      {l.name}
                      {l.imei && <div className={styles.imeiTag}>IMEI: {l.imei}</div>}
                    </div>
                    <button
                      type="button"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--danger)',
                        cursor: 'pointer',
                        padding: 4,
                      }}
                      onClick={() => removeLine(l.id)}
                      aria-label="Remove item"
                    >
                      ✕
                    </button>
                  </div>

                  <div className={styles.lineControls}>
                    {!l.imei ? (
                      <div className={styles.qtyBox}>
                        <button
                          type="button"
                          className={styles.qtyBtn}
                          onClick={() => updateLineQty(l.id, l.qty - 1)}
                        >
                          -
                        </button>
                        <input
                          type="text"
                          className={styles.qtyInput}
                          value={l.qty}
                          readOnly
                        />
                        <button
                          type="button"
                          className={styles.qtyBtn}
                          onClick={() => updateLineQty(l.id, l.qty + 1)}
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontSize: '0.85rem', color: 'var(--label)' }}>Qty: 1</span>
                    )}

                    <div style={{ textAlign: 'right' }}>
                      <div className={styles.lineTotal}>{money(l.lineTotalCents)}</div>
                      {l.discountCents > 0 && (
                        <small style={{ color: 'var(--success)' }}>
                          -{money(l.discountCents)}
                        </small>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Trade-in & Adjustments */}
          <div className={styles.cartAdjustments}>
            <div className={styles.adjustmentRow}>
              <span>Discount (%):</span>
              <input
                type="number"
                min="0"
                max="100"
                value={invoiceDiscountPercent || ''}
                placeholder="0"
                onChange={(e) => setInvoiceDiscountPercent(Number(e.target.value) || 0)}
              />
            </div>

            {/* Trade In */}
            {tradeIn ? (
              <div className={styles.adjustmentRow} style={{ color: 'var(--success)' }}>
                <span>Trade-in ({tradeIn.modelName}):</span>
                <div>
                  <strong>-{money(tradeIn.valuationCents)}</strong>
                  <button
                    type="button"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--danger)',
                      marginLeft: 8,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTradeIn(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--brand)' }}>
                  + Add Trade-In Device
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="Device model (e.g. iPhone 11)"
                    value={tradeInModel}
                    onChange={(e) => setTradeInModel(e.target.value)}
                    style={{ width: '100%', textAlign: 'left' }}
                  />
                  <input
                    type="text"
                    placeholder="IMEI (optional)"
                    value={tradeInImei}
                    onChange={(e) => setTradeInImei(e.target.value)}
                    style={{ width: '100%', textAlign: 'left' }}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      placeholder="Value (LKR)"
                      value={tradeInValuation}
                      onChange={(e) => setTradeInValuation(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <Button
                      variant="secondary"
                      style={{ minHeight: 38, padding: '0 10px', fontSize: '0.8rem' }}
                      onClick={handleApplyTradeIn}
                    >
                      Apply
                    </Button>
                  </div>
                </div>
              </details>
            )}
          </div>

          {/* Totals Summary */}
          <div className={styles.cartSummary}>
            <div className={styles.summaryLine}>
              <span>Subtotal:</span>
              <span>{money(totals.subtotalCents)}</span>
            </div>
            {totals.totalDiscountCents > 0 && (
              <div className={styles.summaryLine} style={{ color: 'var(--success)' }}>
                <span>Discounts:</span>
                <span>-{money(totals.totalDiscountCents)}</span>
              </div>
            )}
            {totals.tradeInValueCents > 0 && (
              <div className={styles.summaryLine} style={{ color: 'var(--success)' }}>
                <span>Trade-in:</span>
                <span>-{money(totals.tradeInValueCents)}</span>
              </div>
            )}
            <div className={styles.grandTotalLine}>
              <span>Total:</span>
              <span className={styles.grandTotalAmount}>{money(totals.grandTotalCents)}</span>
            </div>
          </div>

          {/* Action Buttons: Hold Cart and Pay (F9) */}
          <div className={styles.cartActions}>
            <Button
              variant="secondary"
              onClick={handleHoldCart}
              disabled={lines.length === 0}
            >
              Hold Cart
            </Button>
            <Button
              onClick={() => setIsPaymentOpen(true)}
              disabled={lines.length === 0}
            >
              Pay (F9)
            </Button>
          </div>
        </aside>
      </main>

      {/* Held Carts Drawer */}
      {isHeldOpen && (
        <div className={styles.heldDrawer} role="dialog" aria-modal="true">
          <div className={styles.heldContent}>
            <div className={styles.cartHeader}>
              <h2>Held Carts</h2>
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  minHeight: 44,
                  minWidth: 44,
                }}
                onClick={() => setIsHeldOpen(false)}
              >
                ✕
              </button>
            </div>
            <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
              {heldCarts.length === 0 ? (
                <p style={{ color: 'var(--muted)', textAlign: 'center' }}>No active held carts.</p>
              ) : (
                heldCarts.map((h) => (
                  <div key={h._id} className={styles.heldCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>{h.customerName}</strong>
                      <small style={{ color: 'var(--label)' }}>
                        {new Date(h.heldAt).toLocaleTimeString()}
                      </small>
                    </div>
                    <div>Items: {h.lines?.length || 0}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{money(h.subtotalCents)}</strong>
                      <Button
                        style={{ minHeight: 38, padding: '0 12px', fontSize: '0.85rem' }}
                        onClick={() => handleResumeHeld(h._id)}
                      >
                        Resume Cart
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      <PaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        totals={totals}
        lines={lines}
        customer={customer}
        invoiceDiscountPercent={invoiceDiscountPercent}
        invoiceDiscountAmountCents={invoiceDiscountAmountCents}
        tradeIn={tradeIn}
        notes={notes}
        idempotencyKey={idempotencyKey}
        onSuccess={handleCheckoutSuccess}
        isOnline={isOnline}
      />
    </div>
  );
}
