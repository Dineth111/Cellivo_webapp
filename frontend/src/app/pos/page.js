'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AppHeader,
  Button,
  Badge,
  Alert,
  Spinner,
  money,
} from '../../components/ui';
import PaymentModal from '../../components/pos/PaymentModal';
import ReturnModal from '../../components/pos/ReturnModal';
import useCart, { OFFLINE_MESSAGE } from '../../hooks/useCart';
import {
  searchProducts,
  lookupBarcode,
  lookupImei,
  holdCart,
  getHeldCarts,
  resumeCart,
  getCustomers,
} from '../../lib/posApi';
import styles from './pos.module.css';

const CATEGORIES = ['All', 'Phones', 'Accessories', 'Parts', 'Services'];

export default function PosPage() {
  const router = useRouter();
  const {
    lines,
    customer,
    setCustomer,
    invoiceDiscountPercent,
    setInvoiceDiscountPercent,
    invoiceDiscountAmountCents,
    tradeIn,
    setTradeIn,
    notes,
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
  } = useCart();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [heldCarts, setHeldCarts] = useState([]);
  const [isHeldOpen, setIsHeldOpen] = useState(false);
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [tradeInImei, setTradeInImei] = useState('');
  const [tradeInModel, setTradeInModel] = useState('');
  const [tradeInValuation, setTradeInValuation] = useState('');
  const [successInvoice, setSuccessInvoice] = useState(null);
  const [bannerAlert, setBannerAlert] = useState(null); // { tone, text }
  const [loadingSearch, setLoadingSearch] = useState(false);

  const searchInputRef = useRef(null);

  // Load customers, initial product search, and global keyboard shortcuts on mount
  useEffect(() => {
    searchInputRef.current?.focus();

    getCustomers()
      .then((data) => setCustomers(data || []))
      .catch(() => {});

    // Initial search to populate catalog
    searchProducts('')
      .then((data) => setProducts(data || []))
      .catch(() => {});

    const handleKeyDown = (e) => {
      if (e.key === 'F4') {
        e.preventDefault();
        setIsReturnOpen(true);
      } else if (e.key === 'F9') {
        e.preventDefault();
        setIsPaymentOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setIsPaymentOpen]);

  const handleSearchChange = async (e) => {
    const val = e.target.value;
    setSearchQuery(val);

    if (!val.trim()) {
      try {
        const defaultItems = await searchProducts('');
        setProducts(defaultItems || []);
      } catch {
        setProducts([]);
      }
      return;
    }

    setLoadingSearch(true);
    try {
      const results = await searchProducts(val);
      setProducts(results || []);
    } catch {
      setProducts([]);
    } finally {
      setLoadingSearch(false);
    }
  };

  const handleBarcodeSubmit = async (e) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    setBannerAlert(null);
    setLoadingSearch(true);

    try {
      // 1. First try barcode lookup
      const barcodeItem = await lookupBarcode(query);
      if (barcodeItem) {
        if (barcodeItem.requiresImei && barcodeItem.availableImeis?.length > 0) {
          const used = lines.filter((l) => l.productId === barcodeItem._id).map((l) => l.imei);
          const avail = barcodeItem.availableImeis.find((im) => !used.includes(im));
          if (avail) {
            addProduct(barcodeItem, avail);
            setSearchQuery('');
          } else {
            setBannerAlert({ tone: 'danger', text: 'All available units for this phone are already in the cart.' });
          }
        } else {
          addProduct(barcodeItem);
          setSearchQuery('');
        }
        return;
      }

      // 2. Try IMEI lookup
      const imeiResult = await lookupImei(query);
      if (imeiResult?.product) {
        if (imeiResult.imeiStatus !== 'in_stock') {
          setBannerAlert({
            tone: 'danger',
            text: `IMEI ${query} is ${imeiResult.imeiStatus || 'unavailable'}.`,
          });
          return;
        }
        const alreadyInCart = lines.some((l) => l.imei === query);
        if (alreadyInCart) {
          setBannerAlert({ tone: 'danger', text: `IMEI ${query} is already in the cart.` });
          return;
        }
        addProduct(imeiResult.product, query);
        setSearchQuery('');
        return;
      }

      // 3. Fallback to generic product search
      const searchResults = await searchProducts(query);
      setProducts(searchResults || []);
      if (!searchResults || searchResults.length === 0) {
        setBannerAlert({ tone: 'warning', text: `No products matching "${query}".` });
      }
    } catch (err) {
      setBannerAlert({ tone: 'danger', text: err.message || 'Lookup failed.' });
    } finally {
      setLoadingSearch(false);
    }
  };

  const handleProductClick = (p) => {
    setBannerAlert(null);
    if (p.requiresImei && p.availableImeis?.length > 0) {
      const usedImeis = lines.filter((l) => l.productId === p._id).map((l) => l.imei);
      const available = p.availableImeis.find((im) => !usedImeis.includes(im));
      if (!available) {
        setBannerAlert({
          tone: 'warning',
          text: 'All available IMEI units for this device are currently in the cart.',
        });
        return;
      }
      addProduct(p, available);
    } else {
      addProduct(p);
    }
  };

  const handleApplyTradeIn = () => {
    setBannerAlert(null);
    if (!tradeInModel.trim() || !tradeInValuation) {
      setBannerAlert({ tone: 'danger', text: 'Please specify device model and valuation amount.' });
      return;
    }
    const valCents = Math.round(Number(tradeInValuation) * 100);
    if (isNaN(valCents) || valCents <= 0) {
      setBannerAlert({ tone: 'danger', text: 'Please enter a valid positive valuation amount.' });
      return;
    }

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
    setBannerAlert(null);
    try {
      await holdCart({
        cartName: customer?.name ? `Held for ${customer.name}` : 'Held Cart',
        customer: customer || undefined,
        lines,
        discounts: {
          invoiceDiscountPercent,
          invoiceDiscountAmountCents,
          tradeIn,
          notes,
        },
      });
      clearCart();
      setBannerAlert({ tone: 'success', text: 'Cart held successfully. IMEIs reserved.' });
    } catch (e) {
      setBannerAlert({ tone: 'danger', text: e.message || 'Failed to hold cart.' });
    }
  };

  const handleOpenHeld = async () => {
    setIsHeldOpen(true);
    try {
      const list = await getHeldCarts();
      setHeldCarts(list || []);
    } catch {
      setHeldCarts([]);
    }
  };

  const handleResumeHeld = async (heldId) => {
    setBannerAlert(null);
    try {
      const resumedCart = await resumeCart(heldId);
      if (resumedCart) {
        loadHeldCart(resumedCart);
        setIsHeldOpen(false);
        setBannerAlert({ tone: 'success', text: 'Held cart restored to active register.' });
      }
    } catch (e) {
      setBannerAlert({ tone: 'danger', text: e.message || 'Failed to resume held cart.' });
    }
  };

  const handleCheckoutSuccess = (result, options = {}) => {
    if (result?.invoice) {
      if (options.printReceipt) {
        router.push(`/pos/receipt/${result.invoice._id}?autoprint=true&fresh=true`);
      } else {
        setSuccessInvoice(result.invoice);
      }
    } else if (result?.queued) {
      setBannerAlert({ tone: 'warning', text: OFFLINE_MESSAGE });
    }
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
        {queue.length > 0 && (
          <Badge tone="warning">
            {queue.length} Queued Offline
          </Badge>
        )}
        <Button variant="secondary" onClick={() => setIsReturnOpen(true)} className={styles.cartHeaderBtn}>
          Returns (F4)
        </Button>
        <Button variant="secondary" onClick={handleOpenHeld} className={styles.cartHeaderBtn}>
          Held Carts
        </Button>
        <Link href="/">
          <Button variant="secondary" className={styles.cartHeaderBtn}>Exit POS</Button>
        </Link>
      </AppHeader>

      {/* Offline banner with exact message V-13 */}
      {!isOnline && (
        <div className={styles.offlineBanner}>
          <Alert tone="warning">
            {OFFLINE_MESSAGE}
          </Alert>
        </div>
      )}

      {/* Synced invoices banner (when coming back online) */}
      {synced.length > 0 && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="success">
            Connection restored: {synced.length} offline sale(s) synced successfully.
            <Button
              variant="secondary"
              className={styles.cartHeaderBtn}
              style={{ marginLeft: 12 }}
              onClick={dismissSynced}
            >
              Dismiss
            </Button>
          </Alert>
        </div>
      )}

      {/* Failed offline sync banner */}
      {failed.length > 0 && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="danger">
            {failed.length} offline checkout(s) could not be completed on the server:{' '}
            {failed.map((f) => f.error).join('; ')}
            <Button
              variant="secondary"
              className={styles.cartHeaderBtn}
              style={{ marginLeft: 12 }}
              onClick={() => failed.forEach((f) => dismissFailed(f.idempotencyKey))}
            >
              Dismiss
            </Button>
          </Alert>
        </div>
      )}

      {/* Inline Banner Alerts */}
      {bannerAlert && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone={bannerAlert.tone}>
            {bannerAlert.text}
            <Button
              variant="secondary"
              className={styles.cartHeaderBtn}
              style={{ marginLeft: 12 }}
              onClick={() => setBannerAlert(null)}
            >
              Close
            </Button>
          </Alert>
        </div>
      )}

      {/* Success Modal / Banner */}
      {successInvoice && (
        <div style={{ padding: '10px 20px' }}>
          <Alert tone="success">
            <strong>Sale completed!</strong> Invoice #{successInvoice.invoiceNumber} for {money(successInvoice.grandTotalCents)} recorded.
            <Button
              variant="secondary"
              className={styles.cartHeaderBtn}
              style={{ marginLeft: 12 }}
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
              <Button type="submit" className={styles.cartHeaderBtn}>Search</Button>
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

          {/* Product Cards Grid or Empty State */}
          {filteredProducts.length === 0 && !loadingSearch ? (
            <div className={styles.emptyCatalog}>
              <span style={{ fontSize: '2.5rem' }}>📦</span>
              <h3>No products found</h3>
              <p>Scan a barcode or enter a search query to lookup inventory items.</p>
            </div>
          ) : (
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
          )}
        </section>

        {/* Right: Cart Panel */}
        <aside className={styles.cartSection}>
          <div className={styles.cartHeader}>
            <h2>Current Sale</h2>
            {lines.length > 0 && (
              <Button
                variant="secondary"
                className={styles.cartHeaderBtn}
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
                  {c.name} ({c.phone || 'No phone'}){c.type === 'wholesale' ? ' ★ Wholesale' : ''}
                </option>
              ))}
            </select>
            {customer?.type === 'wholesale' && (
              <div style={{ marginTop: 6 }}>
                <Badge tone="brand">★ Wholesale Tier Applied</Badge>
              </div>
            )}
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
                      className={styles.removeLineBtn}
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
                          aria-label="Decrease quantity"
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
                          aria-label="Increase quantity"
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
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <strong>-{money(tradeIn.valuationCents)}</strong>
                  <button
                    type="button"
                    className={styles.removeTradeInBtn}
                    onClick={() => setTradeIn(null)}
                    aria-label="Remove trade-in"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--brand)', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                  + Add Trade-In Device
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="Device model (e.g. iPhone 11)"
                    value={tradeInModel}
                    onChange={(e) => setTradeInModel(e.target.value)}
                    style={{ width: '100%', textAlign: 'left', minHeight: 44 }}
                  />
                  <input
                    type="text"
                    placeholder="IMEI (optional)"
                    value={tradeInImei}
                    onChange={(e) => setTradeInImei(e.target.value)}
                    style={{ width: '100%', textAlign: 'left', minHeight: 44 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      placeholder="Value (LKR)"
                      value={tradeInValuation}
                      onChange={(e) => setTradeInValuation(e.target.value)}
                      style={{ flex: 1, minHeight: 44 }}
                    />
                    <Button
                      variant="secondary"
                      className={styles.cartHeaderBtn}
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
        <div className={styles.heldDrawer} role="dialog" aria-modal="true" aria-labelledby="held-carts-title">
          <div className={styles.heldContent}>
            <div className={styles.cartHeader}>
              <h2 id="held-carts-title">Held Carts</h2>
              <button
                type="button"
                className={styles.heldCloseBtn}
                onClick={() => setIsHeldOpen(false)}
                aria-label="Close held carts drawer"
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
                      <strong>{h.cartName || 'Held Cart'}</strong>
                      <small style={{ color: 'var(--label)' }}>
                        {new Date(h.createdAt || h.heldAt).toLocaleTimeString()}
                      </small>
                    </div>
                    <div>Items: {h.lines?.length || 0}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{money(h.lines?.reduce((sum, l) => sum + (l.lineTotalCents || 0), 0) || 0)}</strong>
                      <Button
                        className={styles.heldResumeBtn}
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
        customer={customer}
        onSubmitCheckout={submitCheckout}
        onSuccess={handleCheckoutSuccess}
        isOnline={isOnline}
      />

      {/* Return & Exchange Modal */}
      <ReturnModal
        isOpen={isReturnOpen}
        onClose={() => setIsReturnOpen(false)}
        currentCartLines={lines}
        currentCustomer={customer}
        onSuccess={(result) => {
          if (result?.type === 'exchange') {
            clearCart();
            setBannerAlert({
              tone: 'success',
              text: `Counter Exchange complete! CN #${result.creditNoteNumber} issued towards Invoice #${result.exchangeInvoiceNumber}.`,
            });
          } else if (result?.creditNoteNumber) {
            setBannerAlert({
              tone: 'success',
              text: `Return processed successfully! Credit Note #${result.creditNoteNumber} issued.`,
            });
          }
        }}
      />
    </div>
  );
}
