'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  AppHeader,
  Button,
  Badge,
  Alert,
  Card,
  Field,
  Table,
  Spinner,
  money,
  date,
} from '../../components/ui';
import {
  listProducts,
  createProduct,
  updateProduct,
  archiveProduct,
  listCategories,
  getLowStockItems,
  searchImei,
  getImeiTimeline,
  listStockCounts,
  createStockCount,
  approveStockCount,
  getLabelPresets,
  previewLabels,
  generateBarcode,
  listTransfers,
  requestTransfer,
  approveTransfer,
  dispatchTransfer,
  receiveTransfer,
  importProductsCsv,
} from '../../lib/inventoryApi';
import styles from './inventory.module.css';

export default function InventoryPage() {
  const [tab, setTab] = useState('products');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Products state
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [csvText, setCsvText] = useState('');

  // Product form state
  const [prodForm, setProdForm] = useState({
    name: '',
    barcode: '',
    sku: '',
    categoryId: '',
    sellingPriceLKR: '',
    costPriceLKR: '',
    isSerialised: false,
    reorderLevel: 5,
  });

  // IMEI state
  const [imeiInput, setImeiInput] = useState('');
  const [imeiResult, setImeiResult] = useState(null);
  const [imeiTimeline, setImeiTimeline] = useState([]);

  // Stock count state
  const [counts, setCounts] = useState([]);
  const [isCountModalOpen, setIsCountModalOpen] = useState(false);
  const [countItems, setCountItems] = useState([]);

  // Label printing state
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('50x25');
  const [labelProductId, setLabelProductId] = useState('');
  const [labelCopies, setLabelCopies] = useState(1);
  const [labelPreviewData, setLabelPreviewData] = useState(null);

  // Transfers state
  const [transfers, setTransfers] = useState([]);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferForm, setTransferForm] = useState({
    fromBranchId: '',
    toBranchId: '',
    items: [{ productId: '', requestedQty: 1 }],
  });

  // Load initial data
  useEffect(() => {
    loadProducts();
    listCategories().then((res) => setCategories(res.data || [])).catch(() => {});
  }, [lowStockOnly]);

  async function loadProducts() {
    setLoading(true);
    setError('');
    try {
      if (lowStockOnly) {
        const res = await getLowStockItems();
        setProducts(res.data?.map((item) => ({ ...item.product, currentStock: item.currentQty, reorderLevel: item.reorderLevel })) || []);
      } else {
        const res = await listProducts({ search });
        setProducts(res.data || []);
      }
    } catch (err) {
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveProduct(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = {
        name: prodForm.name,
        barcode: prodForm.barcode,
        sku: prodForm.sku,
        categoryId: prodForm.categoryId || null,
        sellingPriceCents: Math.round(Number(prodForm.sellingPriceLKR) * 100),
        costPriceCents: Math.round(Number(prodForm.costPriceLKR) * 100),
        isSerialised: prodForm.isSerialised,
        reorderLevel: Number(prodForm.reorderLevel) || 0,
      };

      if (editingProduct) {
        await updateProduct(editingProduct._id, payload);
        setSuccess('Product updated successfully');
      } else {
        await createProduct(payload);
        setSuccess('Product created successfully');
      }

      setIsProductModalOpen(false);
      setEditingProduct(null);
      loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to save product');
    } finally {
      setLoading(false);
    }
  }

  async function handleAutoBarcode() {
    try {
      const res = await generateBarcode();
      setProdForm((prev) => ({ ...prev, barcode: res.barcode }));
    } catch (err) {
      setError(err.message || 'Failed to generate barcode');
    }
  }

  async function handleImeiSearch(e) {
    e.preventDefault();
    if (!imeiInput.trim()) return;
    setLoading(true);
    setError('');
    setImeiResult(null);
    setImeiTimeline([]);
    try {
      const searchRes = await searchImei(imeiInput.trim());
      if (searchRes.data?.length > 0) {
        const unit = searchRes.data[0];
        setImeiResult(unit);
        const timelineRes = await getImeiTimeline(unit.imei1);
        setImeiTimeline(timelineRes.data || []);
      } else {
        setError(`No serial unit found matching IMEI: ${imeiInput}`);
      }
    } catch (err) {
      setError(err.message || 'Failed to search IMEI');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadCounts() {
    setLoading(true);
    try {
      const res = await listStockCounts();
      setCounts(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load stock counts');
    } finally {
      setLoading(false);
    }
  }

  async function handleApproveCount(countId) {
    setLoading(true);
    try {
      await approveStockCount(countId);
      setSuccess('Stock count approved and adjustments posted');
      handleLoadCounts();
    } catch (err) {
      setError(err.message || 'Failed to approve stock count');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadTransfers() {
    setLoading(true);
    try {
      const res = await listTransfers();
      setTransfers(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load transfers');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadLabels() {
    try {
      const res = await getLabelPresets();
      setPresets(res.data || []);
    } catch (err) {
      // fallback presets
      setPresets([
        { id: '50x25', name: 'Standard (50mm x 25mm)' },
        { id: '38x25', name: 'Compact (38mm x 25mm)' },
        { id: '100x50', name: 'Shipping Box (100mm x 50mm)' },
        { id: 'a4_24', name: 'A4 Sheet (24 labels)' },
      ]);
    }
  }

  async function handlePreviewLabel() {
    const prod = products.find((p) => p._id === labelProductId);
    if (!prod) return;
    setLabelPreviewData({
      productName: prod.name,
      barcode: prod.barcode,
      priceLKR: (prod.sellingPriceCents / 100).toFixed(2),
      preset: selectedPreset,
    });
  }

  async function handleImportCsv(e) {
    e.preventDefault();
    if (!csvText.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await importProductsCsv(csvText);
      setSuccess(`Successfully imported ${res.imported} products.`);
      setIsCsvModalOpen(false);
      setCsvText('');
      loadProducts();
    } catch (err) {
      setError(err.message || 'CSV Import failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <AppHeader chip="INVENTORY">
        <Link href="/" style={{ color: 'var(--secondary)', textDecoration: 'none', marginRight: 16 }}>
          ← Dashboard
        </Link>
        <Link href="/pos" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: 600 }}>
          POS Register
        </Link>
      </AppHeader>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--heading)' }}>Inventory & Catalogue</h1>
            <p style={{ color: 'var(--secondary)' }}>Track products, IMEI serial units, barcodes, counts and branch transfers</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              onClick={() => {
                setEditingProduct(null);
                setProdForm({
                  name: '',
                  barcode: '',
                  sku: '',
                  categoryId: '',
                  sellingPriceLKR: '',
                  costPriceLKR: '',
                  isSerialised: false,
                  reorderLevel: 5,
                });
                setIsProductModalOpen(true);
              }}
            >
              + Add Product
            </Button>
            <Button variant="secondary" onClick={() => setIsCsvModalOpen(true)}>
              Import CSV
            </Button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}

        <nav className={styles.navTabs}>
          <button
            className={`${styles.tabBtn} ${tab === 'products' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('products'); loadProducts(); }}
          >
            Products & Stock
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'imei' ? styles.tabBtnActive : ''}`}
            onClick={() => setTab('imei')}
          >
            IMEI Tracking
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'counts' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('counts'); handleLoadCounts(); }}
          >
            Stock Counts
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'labels' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('labels'); handleLoadLabels(); }}
          >
            Barcode Labels
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'transfers' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('transfers'); handleLoadTransfers(); }}
          >
            Stock Transfers
          </button>
        </nav>

        {/* TAB 1: PRODUCTS & STOCK */}
        {tab === 'products' && (
          <Card>
            <div className={styles.toolbar}>
              <div className={styles.filterGroup}>
                <input
                  className={styles.searchInput}
                  placeholder="Search products or scan barcode..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadProducts()}
                />
                <Button variant="secondary" onClick={loadProducts}>Search</Button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={lowStockOnly}
                    onChange={(e) => setLowStockOnly(e.target.checked)}
                  />
                  <span>Low Stock Only</span>
                </label>
              </div>
            </div>

            {loading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>
            ) : products.length === 0 ? (
              <p style={{ padding: 40, textAlign: 'center', color: 'var(--secondary)' }}>No products found.</p>
            ) : (
              <Table head={['Name', 'Barcode / SKU', 'Category', 'Stock Qty', 'Selling Price', 'Cost Price', 'Type', 'Actions']}>
                {products.map((p) => (
                  <tr key={p._id}>
                    <td><strong>{p.name}</strong></td>
                    <td><code>{p.barcode || p.sku || '-'}</code></td>
                    <td>{p.categoryId?.name || '-'}</td>
                    <td>
                      <Badge tone={p.currentStock <= (p.reorderLevel || 5) ? 'danger' : 'success'}>
                        {p.currentStock != null ? p.currentStock : 'In Stock'}
                      </Badge>
                    </td>
                    <td>{money(p.sellingPriceCents)}</td>
                    <td>{p.costPriceCents != null ? money(p.costPriceCents) : '—'}</td>
                    <td>
                      {p.isSerialised ? <Badge tone="warning">IMEI Tracked</Badge> : <Badge tone="neutral">Standard</Badge>}
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                        onClick={() => {
                          setEditingProduct(p);
                          setProdForm({
                            name: p.name,
                            barcode: p.barcode || '',
                            sku: p.sku || '',
                            categoryId: p.categoryId?._id || p.categoryId || '',
                            sellingPriceLKR: (p.sellingPriceCents / 100).toFixed(2),
                            costPriceLKR: p.costPriceCents ? (p.costPriceCents / 100).toFixed(2) : '',
                            isSerialised: p.isSerialised || false,
                            reorderLevel: p.reorderLevel || 5,
                          });
                          setIsProductModalOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* TAB 2: IMEI TRACKING */}
        {tab === 'imei' && (
          <Card title="IMEI Device Lookup & Lifecycle">
            <form onSubmit={handleImeiSearch} style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <input
                className={styles.searchInput}
                style={{ flex: 1 }}
                placeholder="Scan or enter 15-digit IMEI (e.g. 356938035643809)..."
                value={imeiInput}
                onChange={(e) => setImeiInput(e.target.value)}
              />
              <Button type="submit">Search IMEI</Button>
            </form>

            {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spinner /></div>}

            {imeiResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                  <div>
                    <small style={{ color: 'var(--secondary)' }}>Product</small>
                    <p><strong>{imeiResult.productId?.name || 'Mobile Device'}</strong></p>
                  </div>
                  <div>
                    <small style={{ color: 'var(--secondary)' }}>IMEI 1</small>
                    <p><code>{imeiResult.imei1}</code></p>
                  </div>
                  <div>
                    <small style={{ color: 'var(--secondary)' }}>Status</small>
                    <p>
                      <Badge
                        tone={
                          imeiResult.status === 'in_stock'
                            ? 'success'
                            : imeiResult.status === 'sold'
                            ? 'neutral'
                            : imeiResult.status === 'reserved'
                            ? 'warning'
                            : 'danger'
                        }
                      >
                        {imeiResult.status.replace(/_/g, ' ').toUpperCase()}
                      </Badge>
                    </p>
                  </div>
                  <div>
                    <small style={{ color: 'var(--secondary)' }}>Branch</small>
                    <p>{imeiResult.branchId?.name || 'Main Branch'}</p>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                  <h3>Lifecycle Timeline</h3>
                  {imeiTimeline.length === 0 ? (
                    <p style={{ color: 'var(--secondary)', marginTop: 8 }}>No history movements recorded yet.</p>
                  ) : (
                    <div className={styles.timeline}>
                      {imeiTimeline.map((item, idx) => (
                        <div key={idx} className={styles.timelineItem}>
                          <div className={styles.timelineDot} />
                          <strong>{item.type?.replace(/_/g, ' ').toUpperCase()}</strong>
                          <small style={{ color: 'var(--secondary)' }}>{date(item.createdAt)} · {item.branchId?.name || 'Branch'}</small>
                          <p style={{ fontSize: 13 }}>{item.note || item.referenceId || ''}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* TAB 3: STOCK COUNTS */}
        {tab === 'counts' && (
          <Card title="Stock Counts & Physical Variance Auditing">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsCountModalOpen(true)}>+ Start New Count</Button>
            </div>

            {counts.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No stock counts created yet.</p>
            ) : (
              <Table head={['Count #', 'Status', 'Started At', 'Approved At', 'Notes', 'Actions']}>
                {counts.map((c) => (
                  <tr key={c._id}>
                    <td><strong>{c.countNumber}</strong></td>
                    <td>
                      <Badge tone={c.status === 'approved' ? 'success' : 'warning'}>{c.status.toUpperCase()}</Badge>
                    </td>
                    <td>{date(c.createdAt)}</td>
                    <td>{date(c.approvedAt)}</td>
                    <td>{c.notes || '-'}</td>
                    <td>
                      {c.status === 'draft' && (
                        <Button
                          style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                          onClick={() => handleApproveCount(c._id)}
                        >
                          Approve & Post
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* TAB 4: BARCODE LABELS */}
        {tab === 'labels' && (
          <Card title="Print Barcode Labels">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Field label="Select Product" as="select" value={labelProductId} onChange={(e) => setLabelProductId(e.target.value)}>
                  <option value="">-- Choose Product --</option>
                  {products.map((p) => (
                    <option key={p._id} value={p._id}>{p.name} ({p.barcode || 'No barcode'})</option>
                  ))}
                </Field>

                <Field label="Label Preset" as="select" value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)}>
                  {presets.map((pr) => (
                    <option key={pr.id || pr} value={pr.id || pr}>{pr.name || pr}</option>
                  ))}
                </Field>

                <Field label="Number of Copies" type="number" min="1" value={labelCopies} onChange={(e) => setLabelCopies(e.target.value)} />

                <div style={{ display: 'flex', gap: 10 }}>
                  <Button type="button" onClick={handlePreviewLabel}>Preview Label</Button>
                  <Button type="button" variant="secondary" onClick={() => window.print()}>Print</Button>
                </div>
              </div>

              <div>
                <h4 style={{ marginBottom: 12 }}>Label Preview</h4>
                {labelPreviewData ? (
                  <div className={styles.labelPreview}>
                    <strong style={{ fontSize: 13, textAlign: 'center' }}>{labelPreviewData.productName}</strong>
                    <div className={styles.barcodeLines}>||| | |||| |||</div>
                    <code style={{ fontSize: 12 }}>{labelPreviewData.barcode}</code>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>Rs {labelPreviewData.priceLKR}</span>
                    <small style={{ color: 'var(--secondary)', fontSize: 11 }}>{labelPreviewData.preset}</small>
                  </div>
                ) : (
                  <p style={{ color: 'var(--secondary)' }}>Select a product and click Preview.</p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* TAB 5: STOCK TRANSFERS */}
        {tab === 'transfers' && (
          <Card title="Inter-Branch Stock Transfers">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsTransferModalOpen(true)}>+ Request Transfer</Button>
            </div>

            {transfers.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No transfers found.</p>
            ) : (
              <Table head={['Transfer #', 'From Branch', 'To Branch', 'Status', 'Items', 'Requested At', 'Actions']}>
                {transfers.map((t) => (
                  <tr key={t._id}>
                    <td><strong>{t.transferNumber}</strong></td>
                    <td>{t.fromBranchId?.name || 'Branch'}</td>
                    <td>{t.toBranchId?.name || 'Branch'}</td>
                    <td>
                      <Badge
                        tone={
                          t.status === 'completed'
                            ? 'success'
                            : t.status === 'dispatched'
                            ? 'warning'
                            : t.status === 'requested'
                            ? 'neutral'
                            : 'danger'
                        }
                      >
                        {t.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td>{t.items?.length || 0} item(s)</td>
                    <td>{date(t.createdAt)}</td>
                    <td>
                      {t.status === 'requested' && (
                        <Button
                          style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                          onClick={async () => {
                            await approveTransfer(t._id);
                            handleLoadTransfers();
                          }}
                        >
                          Approve
                        </Button>
                      )}
                      {t.status === 'approved' && (
                        <Button
                          style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                          onClick={async () => {
                            await dispatchTransfer(t._id, {});
                            handleLoadTransfers();
                          }}
                        >
                          Dispatch
                        </Button>
                      )}
                      {t.status === 'dispatched' && (
                        <Button
                          style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                          onClick={async () => {
                            const receivedItems = t.items.map((i) => ({ productId: i.productId, receivedQty: i.dispatchedQty }));
                            await receiveTransfer(t._id, { items: receivedItems });
                            handleLoadTransfers();
                          }}
                        >
                          Receive All
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* MODAL: ADD / EDIT PRODUCT */}
        {isProductModalOpen && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <h3>{editingProduct ? 'Edit Product' : 'Add New Product'}</h3>
                <button
                  style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}
                  onClick={() => setIsProductModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleSaveProduct}>
                <div className={styles.modalBody}>
                  <Field
                    label="Product Name *"
                    required
                    value={prodForm.name}
                    onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })}
                  />

                  <div className={styles.grid2}>
                    <div>
                      <Field
                        label="Barcode (scan or enter)"
                        value={prodForm.barcode}
                        onChange={(e) => setProdForm({ ...prodForm, barcode: e.target.value })}
                      />
                      <button
                        type="button"
                        style={{ fontSize: 12, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4 }}
                        onClick={handleAutoBarcode}
                      >
                        ⚡ Generate Barcode
                      </button>
                    </div>
                    <Field
                      label="SKU"
                      value={prodForm.sku}
                      onChange={(e) => setProdForm({ ...prodForm, sku: e.target.value })}
                    />
                  </div>

                  <div className={styles.grid2}>
                    <Field
                      label="Selling Price (LKR) *"
                      type="number"
                      step="0.01"
                      required
                      value={prodForm.sellingPriceLKR}
                      onChange={(e) => setProdForm({ ...prodForm, sellingPriceLKR: e.target.value })}
                    />
                    <Field
                      label="Cost Price (LKR)"
                      type="number"
                      step="0.01"
                      value={prodForm.costPriceLKR}
                      onChange={(e) => setProdForm({ ...prodForm, costPriceLKR: e.target.value })}
                    />
                  </div>

                  <div className={styles.grid2}>
                    <Field
                      label="Category"
                      as="select"
                      value={prodForm.categoryId}
                      onChange={(e) => setProdForm({ ...prodForm, categoryId: e.target.value })}
                    >
                      <option value="">-- None --</option>
                      {categories.map((c) => (
                        <option key={c._id} value={c._id}>{c.name}</option>
                      ))}
                    </Field>

                    <Field
                      label="Reorder Level"
                      type="number"
                      min="0"
                      value={prodForm.reorderLevel}
                      onChange={(e) => setProdForm({ ...prodForm, reorderLevel: e.target.value })}
                    />
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={prodForm.isSerialised}
                      onChange={(e) => setProdForm({ ...prodForm, isSerialised: e.target.checked })}
                    />
                    <span><strong>Serialised Product</strong> (Requires IMEI scanning for each phone/device)</span>
                  </label>
                </div>

                <div className={styles.modalFooter}>
                  <Button type="button" variant="secondary" onClick={() => setIsProductModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit">Save Product</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL: CSV IMPORT */}
        {isCsvModalOpen && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <h3>Import Products from CSV</h3>
                <button
                  style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}
                  onClick={() => setIsCsvModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleImportCsv}>
                <div className={styles.modalBody}>
                  <p style={{ fontSize: 13, color: 'var(--secondary)' }}>
                    Paste CSV with header: <code>name,barcode,sellingPriceCents,costPriceCents,isSerialised</code>.
                    Imports are all-or-nothing with row-level validation.
                  </p>
                  <textarea
                    rows={8}
                    className={styles.searchInput}
                    style={{ width: '100%', height: 160, fontFamily: 'monospace', padding: 8 }}
                    placeholder="name,barcode,sellingPriceCents,costPriceCents,isSerialised&#10;Samsung A15,SAM-A15,5500000,4500000,true"
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                  />
                </div>
                <div className={styles.modalFooter}>
                  <Button type="button" variant="secondary" onClick={() => setIsCsvModalOpen(false)}>Cancel</Button>
                  <Button type="submit">Import All Rows</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
