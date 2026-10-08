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
  Stat,
  money,
  date,
} from '../../components/ui';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  listPurchaseOrders,
  createPurchaseOrder,
  updatePoStatus,
  listGrns,
  createGrn,
  listBills,
  getBillsAgeing,
  listPayments,
  createPayment,
  listPurchaseReturns,
  createPurchaseReturn,
  listProducts,
} from '../../lib/inventoryApi';
import styles from './purchasing.module.css';

export default function PurchasingPage() {
  const [tab, setTab] = useState('suppliers');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Suppliers state
  const [suppliers, setSuppliers] = useState([]);
  const [searchSupplier, setSearchSupplier] = useState('');
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [supForm, setSupForm] = useState({
    name: '',
    contactPerson: '',
    phone: '',
    email: '',
    paymentTermsDays: 30,
    openingBalanceLKR: '0',
    notes: '',
  });

  // POs state
  const [orders, setOrders] = useState([]);
  const [isPoModalOpen, setIsPoModalOpen] = useState(false);
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poItems, setPoItems] = useState([{ productId: '', qty: 1, unitCostLKR: '' }]);
  const [availableProducts, setAvailableProducts] = useState([]);

  // GRN state
  const [grns, setGrns] = useState([]);
  const [isGrnModalOpen, setIsGrnModalOpen] = useState(false);
  const [grnSupplierId, setGrnSupplierId] = useState('');
  const [grnPaymentType, setGrnPaymentType] = useState('credit');
  const [grnItems, setGrnItems] = useState([
    { productId: '', qty: 1, unitCostLKR: '', imeis: '', isSerialised: false },
  ]);

  // Bills & Ageing state
  const [bills, setBills] = useState([]);
  const [ageing, setAgeing] = useState(null);

  // Payments state
  const [payments, setPayments] = useState([]);
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);
  const [payForm, setPayForm] = useState({
    supplierId: '',
    billId: '',
    amountLKR: '',
    paymentMethod: 'cash',
    reference: '',
    notes: '',
  });

  // Returns state
  const [returns, setReturns] = useState([]);
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [returnForm, setReturnForm] = useState({
    supplierId: '',
    items: [{ productId: '', qty: 1, unitCostLKR: '', imeis: '', reason: '' }],
    notes: '',
  });

  useEffect(() => {
    loadSuppliers();
    listProducts().then((res) => setAvailableProducts(res.data || [])).catch(() => {});
  }, []);

  async function loadSuppliers() {
    setLoading(true);
    setError('');
    try {
      const res = await listSuppliers({ search: searchSupplier });
      setSuppliers(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveSupplier(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const payload = {
        name: supForm.name,
        contactPerson: supForm.contactPerson,
        phone: supForm.phone,
        email: supForm.email,
        paymentTermsDays: Number(supForm.paymentTermsDays) || 30,
        openingBalanceCents: Math.round(Number(supForm.openingBalanceLKR) * 100) || 0,
        notes: supForm.notes,
      };

      if (editingSupplier) {
        await updateSupplier(editingSupplier._id, payload);
        setSuccess('Supplier updated successfully');
      } else {
        await createSupplier(payload);
        setSuccess('Supplier created successfully');
      }

      setIsSupplierModalOpen(false);
      setEditingSupplier(null);
      loadSuppliers();
    } catch (err) {
      setError(err.message || 'Failed to save supplier');
    } finally {
      setLoading(false);
    }
  }

  async function loadOrders() {
    setLoading(true);
    try {
      const res = await listPurchaseOrders();
      setOrders(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load purchase orders');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatePo(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const items = poItems.map((item) => ({
        productId: item.productId,
        qty: Number(item.qty) || 1,
        unitCostCents: Math.round(Number(item.unitCostLKR) * 100),
      }));

      await createPurchaseOrder({
        supplierId: poSupplierId,
        items,
      });

      setSuccess('Purchase order created');
      setIsPoModalOpen(false);
      loadOrders();
    } catch (err) {
      setError(err.message || 'Failed to create PO');
    } finally {
      setLoading(false);
    }
  }

  async function loadGrns() {
    setLoading(true);
    try {
      const res = await listGrns();
      setGrns(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load GRNs');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGrn(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const items = grnItems.map((item) => {
        const prod = availableProducts.find((p) => p._id === item.productId);
        const imeis = item.imeis
          ? item.imeis.split(/[\n, ]+/).map((s) => s.trim()).filter(Boolean)
          : [];

        return {
          productId: item.productId,
          qty: Number(item.qty) || 1,
          unitCostCents: Math.round(Number(item.unitCostLKR) * 100),
          imeis: prod?.isSerialised ? imeis : [],
        };
      });

      await createGrn({
        supplierId: grnSupplierId,
        paymentType: grnPaymentType,
        items,
      });

      setSuccess('Goods Received Note posted successfully and inventory updated');
      setIsGrnModalOpen(false);
      loadGrns();
    } catch (err) {
      setError(err.message || 'Failed to create GRN');
    } finally {
      setLoading(false);
    }
  }

  async function loadBillsAndAgeing() {
    setLoading(true);
    try {
      const [billsRes, ageingRes] = await Promise.all([listBills(), getBillsAgeing()]);
      setBills(billsRes.data || []);
      setAgeing(ageingRes.data || null);
    } catch (err) {
      setError(err.message || 'Failed to load bills');
    } finally {
      setLoading(false);
    }
  }

  async function loadPayments() {
    setLoading(true);
    try {
      const res = await listPayments();
      setPayments(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatePayment(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await createPayment({
        supplierId: payForm.supplierId,
        billId: payForm.billId || null,
        amountCents: Math.round(Number(payForm.amountLKR) * 100),
        paymentMethod: payForm.paymentMethod,
        reference: payForm.reference,
        notes: payForm.notes,
      });

      setSuccess('Payment recorded and posted to ledger');
      setIsPayModalOpen(false);
      loadPayments();
    } catch (err) {
      setError(err.message || 'Failed to record payment');
    } finally {
      setLoading(false);
    }
  }

  async function loadReturns() {
    setLoading(true);
    try {
      const res = await listPurchaseReturns();
      setReturns(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load purchase returns');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateReturn(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const items = returnForm.items.map((i) => ({
        productId: i.productId,
        qty: Number(i.qty) || 1,
        unitCostCents: Math.round(Number(i.unitCostLKR) * 100),
        imeis: i.imeis ? i.imeis.split(/[\n, ]+/).map((s) => s.trim()).filter(Boolean) : [],
        reason: i.reason,
      }));

      await createPurchaseReturn({
        supplierId: returnForm.supplierId,
        items,
        notes: returnForm.notes,
      });

      setSuccess('Purchase return created');
      setIsReturnModalOpen(false);
      loadReturns();
    } catch (err) {
      setError(err.message || 'Failed to create return');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <AppHeader chip="PURCHASING">
        <Link href="/" style={{ color: 'var(--secondary)', textDecoration: 'none', marginRight: 16 }}>
          ← Dashboard
        </Link>
        <Link href="/inventory" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: 600 }}>
          Inventory
        </Link>
      </AppHeader>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--heading)' }}>Purchasing & Suppliers</h1>
            <p style={{ color: 'var(--secondary)' }}>Suppliers, purchase orders, goods received (GRN), bills & returns</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              onClick={() => {
                setEditingSupplier(null);
                setSupForm({
                  name: '',
                  contactPerson: '',
                  phone: '',
                  email: '',
                  paymentTermsDays: 30,
                  openingBalanceLKR: '0',
                  notes: '',
                });
                setIsSupplierModalOpen(true);
              }}
            >
              + Add Supplier
            </Button>
            <Button variant="secondary" onClick={() => setIsGrnModalOpen(true)}>
              + Receive Goods (GRN)
            </Button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}

        <nav className={styles.navTabs}>
          <button
            className={`${styles.tabBtn} ${tab === 'suppliers' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('suppliers'); loadSuppliers(); }}
          >
            Suppliers
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'orders' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('orders'); loadOrders(); }}
          >
            Purchase Orders
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'grn' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('grn'); loadGrns(); }}
          >
            Goods Received (GRN)
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'bills' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('bills'); loadBillsAndAgeing(); }}
          >
            Bills & Ageing
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'payments' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('payments'); loadPayments(); }}
          >
            Payments
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'returns' ? styles.tabBtnActive : ''}`}
            onClick={() => { setTab('returns'); loadReturns(); }}
          >
            Purchase Returns
          </button>
        </nav>

        {/* TAB 1: SUPPLIERS */}
        {tab === 'suppliers' && (
          <Card>
            <div className={styles.toolbar}>
              <input
                className={styles.searchInput}
                placeholder="Search suppliers by name, phone..."
                value={searchSupplier}
                onChange={(e) => setSearchSupplier(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadSuppliers()}
              />
              <Button variant="secondary" onClick={loadSuppliers}>Search</Button>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
            ) : suppliers.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No suppliers found.</p>
            ) : (
              <Table head={['Supplier Name', 'Contact Person', 'Phone / Email', 'Terms', 'Current Balance', 'Actions']}>
                {suppliers.map((s) => (
                  <tr key={s._id}>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.contactPerson || '-'}</td>
                    <td>
                      <div>{s.phone || '-'}</div>
                      <small style={{ color: 'var(--secondary)' }}>{s.email || ''}</small>
                    </td>
                    <td>{s.paymentTermsDays || 30} days</td>
                    <td>
                      <strong style={{ color: s.currentBalanceCents > 0 ? 'var(--danger)' : 'inherit' }}>
                        {money(s.currentBalanceCents || 0)}
                      </strong>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                        onClick={() => {
                          setEditingSupplier(s);
                          setSupForm({
                            name: s.name,
                            contactPerson: s.contactPerson || '',
                            phone: s.phone || '',
                            email: s.email || '',
                            paymentTermsDays: s.paymentTermsDays || 30,
                            openingBalanceLKR: (s.openingBalanceCents / 100).toFixed(2),
                            notes: s.notes || '',
                          });
                          setIsSupplierModalOpen(true);
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

        {/* TAB 2: PURCHASE ORDERS */}
        {tab === 'orders' && (
          <Card title="Purchase Orders">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsPoModalOpen(true)}>+ Create Purchase Order</Button>
            </div>

            {orders.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No purchase orders created yet.</p>
            ) : (
              <Table head={['PO #', 'Supplier', 'Items', 'Total Cost', 'Status', 'Date', 'Actions']}>
                {orders.map((po) => (
                  <tr key={po._id}>
                    <td><strong>{po.poNumber}</strong></td>
                    <td>{po.supplierId?.name || 'Supplier'}</td>
                    <td>{po.items?.length || 0} item(s)</td>
                    <td><strong>{money(po.totalCents || 0)}</strong></td>
                    <td>
                      <Badge
                        tone={
                          po.status === 'received'
                            ? 'success'
                            : po.status === 'sent'
                            ? 'warning'
                            : po.status === 'draft'
                            ? 'neutral'
                            : 'danger'
                        }
                      >
                        {po.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td>{date(po.createdAt)}</td>
                    <td>
                      {po.status === 'draft' && (
                        <Button
                          style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                          onClick={async () => {
                            await updatePoStatus(po._id, 'sent');
                            loadOrders();
                          }}
                        >
                          Send PO
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* TAB 3: GOODS RECEIVED NOTES (GRN) */}
        {tab === 'grn' && (
          <Card title="Goods Received Notes (GRN)">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsGrnModalOpen(true)}>+ New GRN Entry</Button>
            </div>

            {grns.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No GRN entries found.</p>
            ) : (
              <Table head={['GRN #', 'Supplier', 'Payment', 'Total Amount', 'Items', 'Date']}>
                {grns.map((g) => (
                  <tr key={g._id}>
                    <td><strong>{g.grnNumber}</strong></td>
                    <td>{g.supplierId?.name || 'Supplier'}</td>
                    <td><Badge tone={g.paymentType === 'credit' ? 'warning' : 'success'}>{g.paymentType.toUpperCase()}</Badge></td>
                    <td><strong>{money(g.totalAmountCents)}</strong></td>
                    <td>{g.items?.length || 0} item(s)</td>
                    <td>{date(g.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* TAB 4: BILLS & AGEING */}
        {tab === 'bills' && (
          <div>
            {ageing && (
              <div className={styles.ageingGrid}>
                <Stat label="Total Outstanding" value={money(ageing.totalOutstandingCents)} helper="Accounts Payable" />
                <Stat label="Current (0-30 Days)" value={money(ageing.currentCents)} helper="Within terms" />
                <Stat label="31-60 Days" value={money(ageing.thirtyToSixtyCents)} helper="Overdue" />
                <Stat label="61-90 Days" value={money(ageing.sixtyToNinetyCents)} helper="Critical" />
                <Stat label="Over 90 Days" value={money(ageing.overNinetyCents)} helper="High priority" />
              </div>
            )}

            <Card title="Supplier Bills">
              {bills.length === 0 ? (
                <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No unpaid bills.</p>
              ) : (
                <Table head={['Bill #', 'Supplier', 'Total', 'Paid', 'Balance', 'Due Date', 'Status', 'Actions']}>
                  {bills.map((b) => (
                    <tr key={b._id}>
                      <td><strong>{b.billNumber}</strong></td>
                      <td>{b.supplierId?.name || 'Supplier'}</td>
                      <td>{money(b.totalAmountCents)}</td>
                      <td>{money(b.paidAmountCents || 0)}</td>
                      <td><strong style={{ color: 'var(--danger)' }}>{money(b.balanceCents)}</strong></td>
                      <td>{date(b.dueDate)}</td>
                      <td><Badge tone={b.status === 'paid' ? 'success' : 'warning'}>{b.status.toUpperCase()}</Badge></td>
                      <td>
                        {b.balanceCents > 0 && (
                          <Button
                            style={{ padding: '4px 10px', minHeight: 32, fontSize: 13 }}
                            onClick={() => {
                              setPayForm({
                                supplierId: b.supplierId?._id || b.supplierId,
                                billId: b._id,
                                amountLKR: (b.balanceCents / 100).toFixed(2),
                                paymentMethod: 'cash',
                                reference: '',
                                notes: `Payment for ${b.billNumber}`,
                              });
                              setIsPayModalOpen(true);
                            }}
                          >
                            Pay Bill
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}

        {/* TAB 5: PAYMENTS */}
        {tab === 'payments' && (
          <Card title="Supplier Payments History">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsPayModalOpen(true)}>+ Record Payment</Button>
            </div>

            {payments.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No payments recorded yet.</p>
            ) : (
              <Table head={['Payment #', 'Supplier', 'Amount Paid', 'Method', 'Reference', 'Date']}>
                {payments.map((p) => (
                  <tr key={p._id}>
                    <td><strong>{p.paymentNumber}</strong></td>
                    <td>{p.supplierId?.name || 'Supplier'}</td>
                    <td><strong>{money(p.amountCents)}</strong></td>
                    <td><Badge tone="neutral">{p.paymentMethod.toUpperCase()}</Badge></td>
                    <td>{p.reference || '-'}</td>
                    <td>{date(p.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* TAB 6: RETURNS */}
        {tab === 'returns' && (
          <Card title="Purchase Returns to Suppliers">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button onClick={() => setIsReturnModalOpen(true)}>+ New Purchase Return</Button>
            </div>

            {returns.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: 'var(--secondary)' }}>No purchase returns recorded.</p>
            ) : (
              <Table head={['Return #', 'Supplier', 'Total Credited', 'Items', 'Date']}>
                {returns.map((r) => (
                  <tr key={r._id}>
                    <td><strong>{r.returnNumber}</strong></td>
                    <td>{r.supplierId?.name || 'Supplier'}</td>
                    <td><strong>{money(r.totalAmountCents)}</strong></td>
                    <td>{r.items?.length || 0} item(s)</td>
                    <td>{date(r.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {/* MODAL: SUPPLIER */}
        {isSupplierModalOpen && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <h3>{editingSupplier ? 'Edit Supplier' : 'Add New Supplier'}</h3>
                <button
                  style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}
                  onClick={() => setIsSupplierModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleSaveSupplier}>
                <div className={styles.modalBody}>
                  <Field
                    label="Supplier / Company Name *"
                    required
                    value={supForm.name}
                    onChange={(e) => setSupForm({ ...supForm, name: e.target.value })}
                  />

                  <div className={styles.grid2}>
                    <Field
                      label="Contact Person"
                      value={supForm.contactPerson}
                      onChange={(e) => setSupForm({ ...supForm, contactPerson: e.target.value })}
                    />
                    <Field
                      label="Phone"
                      value={supForm.phone}
                      onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })}
                    />
                  </div>

                  <div className={styles.grid2}>
                    <Field
                      label="Email"
                      type="email"
                      value={supForm.email}
                      onChange={(e) => setSupForm({ ...supForm, email: e.target.value })}
                    />
                    <Field
                      label="Payment Terms (Days)"
                      type="number"
                      min="0"
                      value={supForm.paymentTermsDays}
                      onChange={(e) => setSupForm({ ...supForm, paymentTermsDays: e.target.value })}
                    />
                  </div>

                  {!editingSupplier && (
                    <Field
                      label="Opening Balance (LKR)"
                      type="number"
                      step="0.01"
                      value={supForm.openingBalanceLKR}
                      onChange={(e) => setSupForm({ ...supForm, openingBalanceLKR: e.target.value })}
                    />
                  )}

                  <Field
                    label="Notes"
                    as="textarea"
                    value={supForm.notes}
                    onChange={(e) => setSupForm({ ...supForm, notes: e.target.value })}
                  />
                </div>
                <div className={styles.modalFooter}>
                  <Button type="button" variant="secondary" onClick={() => setIsSupplierModalOpen(false)}>Cancel</Button>
                  <Button type="submit">Save Supplier</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL: GRN */}
        {isGrnModalOpen && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <h3>Receive Goods (GRN)</h3>
                <button
                  style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}
                  onClick={() => setIsGrnModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleCreateGrn}>
                <div className={styles.modalBody}>
                  <div className={styles.grid2}>
                    <Field
                      label="Supplier *"
                      as="select"
                      required
                      value={grnSupplierId}
                      onChange={(e) => setGrnSupplierId(e.target.value)}
                    >
                      <option value="">-- Select Supplier --</option>
                      {suppliers.map((s) => (
                        <option key={s._id} value={s._id}>{s.name}</option>
                      ))}
                    </Field>

                    <Field
                      label="Payment Type"
                      as="select"
                      value={grnPaymentType}
                      onChange={(e) => setGrnPaymentType(e.target.value)}
                    >
                      <option value="credit">On Credit (Generate Bill)</option>
                      <option value="cash">Cash (Paid Immediately)</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="cheque">Cheque</option>
                    </Field>
                  </div>

                  <h4>Items</h4>
                  {grnItems.map((item, idx) => {
                    const prod = availableProducts.find((p) => p._id === item.productId);
                    return (
                      <div key={idx} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className={styles.grid2}>
                          <Field
                            label="Product *"
                            as="select"
                            required
                            value={item.productId}
                            onChange={(e) => {
                              const pId = e.target.value;
                              const p = availableProducts.find((x) => x._id === pId);
                              const updated = [...grnItems];
                              updated[idx].productId = pId;
                              if (p?.costPriceCents) updated[idx].unitCostLKR = (p.costPriceCents / 100).toFixed(2);
                              setGrnItems(updated);
                            }}
                          >
                            <option value="">-- Choose Product --</option>
                            {availableProducts.map((p) => (
                              <option key={p._id} value={p._id}>{p.name} {p.isSerialised ? '(IMEI Required)' : ''}</option>
                            ))}
                          </Field>

                          <Field
                            label="Quantity *"
                            type="number"
                            min="1"
                            required
                            value={item.qty}
                            onChange={(e) => {
                              const updated = [...grnItems];
                              updated[idx].qty = e.target.value;
                              setGrnItems(updated);
                            }}
                          />
                        </div>

                        <Field
                          label="Unit Cost (LKR) *"
                          type="number"
                          step="0.01"
                          required
                          value={item.unitCostLKR}
                          onChange={(e) => {
                            const updated = [...grnItems];
                            updated[idx].unitCostLKR = e.target.value;
                            setGrnItems(updated);
                          }}
                        />

                        {prod?.isSerialised && (
                          <Field
                            label="Scan IMEIs (separate by comma or newline) *"
                            as="textarea"
                            required
                            placeholder="Enter 15-digit valid Luhn IMEIs..."
                            value={item.imeis}
                            onChange={(e) => {
                              const updated = [...grnItems];
                              updated[idx].imeis = e.target.value;
                              setGrnItems(updated);
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className={styles.modalFooter}>
                  <Button type="button" variant="secondary" onClick={() => setIsGrnModalOpen(false)}>Cancel</Button>
                  <Button type="submit">Post GRN & Update Stock</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL: PAY SUPPLIER */}
        {isPayModalOpen && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <h3>Record Supplier Payment</h3>
                <button
                  style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}
                  onClick={() => setIsPayModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <form onSubmit={handleCreatePayment}>
                <div className={styles.modalBody}>
                  <Field
                    label="Supplier *"
                    as="select"
                    required
                    value={payForm.supplierId}
                    onChange={(e) => setPayForm({ ...payForm, supplierId: e.target.value })}
                  >
                    <option value="">-- Choose Supplier --</option>
                    {suppliers.map((s) => (
                      <option key={s._id} value={s._id}>{s.name} (Balance: {money(s.currentBalanceCents)})</option>
                    ))}
                  </Field>

                  <div className={styles.grid2}>
                    <Field
                      label="Amount to Pay (LKR) *"
                      type="number"
                      step="0.01"
                      required
                      value={payForm.amountLKR}
                      onChange={(e) => setPayForm({ ...payForm, amountLKR: e.target.value })}
                    />

                    <Field
                      label="Payment Method"
                      as="select"
                      value={payForm.paymentMethod}
                      onChange={(e) => setPayForm({ ...payForm, paymentMethod: e.target.value })}
                    >
                      <option value="cash">Cash (1010)</option>
                      <option value="bank_transfer">Bank Transfer (1030)</option>
                      <option value="card">Card (1020)</option>
                      <option value="cheque">Cheque (1030)</option>
                    </Field>
                  </div>

                  <Field
                    label="Cheque / Reference Number"
                    value={payForm.reference}
                    onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                  />

                  <Field
                    label="Notes"
                    as="textarea"
                    value={payForm.notes}
                    onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                  />
                </div>
                <div className={styles.modalFooter}>
                  <Button type="button" variant="secondary" onClick={() => setIsPayModalOpen(false)}>Cancel</Button>
                  <Button type="submit">Record Payment</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
