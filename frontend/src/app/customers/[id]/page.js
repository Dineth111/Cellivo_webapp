'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  getCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerHistory,
  getAuthProfile,
  hasSession,
} from '../../../lib/api';
import {
  Alert,
  AppHeader,
  Badge,
  Button,
  Card,
  Field,
  Hero,
  Spinner,
  Stat,
  StatGrid,
  Table,
  User,
  date,
  money,
} from '../../../components/ui';

export default function CustomerProfilePage() {
  const { id } = useParams();
  const router = useRouter();

  const [profile, setProfile] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [history, setHistory] = useState(null);
  const [activeTab, setActiveTab] = useState('details'); // 'details' | 'history' | 'loyalty'
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Edit Modal State
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({
    name: '',
    phone: '',
    nic: '',
    email: '',
    address: '',
    type: 'retail',
    tags: '',
    marketingOptIn: false,
    notes: '',
  });
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  const loadCustomer = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [cRes, hRes] = await Promise.all([
        getCustomer(id),
        getCustomerHistory(id, { limit: 50 }).catch(() => ({ data: null })),
      ]);
      setCustomer(cRes.data);
      setHistory(hRes.data);
      if (cRes.data) {
        setEditForm({
          name: cRes.data.name || '',
          phone: cRes.data.phone || '',
          nic: cRes.data.nic || '',
          email: cRes.data.email || '',
          address: cRes.data.address || '',
          type: cRes.data.type || 'retail',
          tags: (cRes.data.tags || []).join(', '),
          marketingOptIn: cRes.data.marketingOptIn === true,
          notes: cRes.data.notes || '',
        });
      }
    } catch (err) {
      setError(err.message || 'Failed to load customer profile');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!hasSession()) {
      Promise.resolve().then(() => {
        setIsLoggedIn(false);
        setLoading(false);
      });
      return;
    }
    let ignore = false;
    getAuthProfile()
      .then((p) => {
        if (!ignore) setProfile(p.data);
      })
      .catch(() => {});
    Promise.resolve().then(() => {
      if (!ignore) loadCustomer();
    });
    return () => {
      ignore = true;
    };
  }, [loadCustomer]);

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setEditBusy(true);
    setEditError('');

    const payload = {
      name: editForm.name.trim(),
      phone: editForm.phone.trim(),
      nic: editForm.nic.trim(),
      email: editForm.email.trim(),
      address: editForm.address.trim(),
      type: editForm.type,
      tags: editForm.tags ? editForm.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      marketingOptIn: editForm.marketingOptIn,
      notes: editForm.notes.trim(),
    };

    try {
      const res = await updateCustomer(id, payload);
      setCustomer(res.data);
      setSuccessMsg('Customer details updated successfully.');
      setShowEditModal(false);
      loadCustomer();
    } catch (err) {
      setEditError(err.message || 'Update failed');
    } finally {
      setEditBusy(false);
    }
  };

  const handleArchive = async () => {
    if (!window.confirm(`Are you sure you want to archive customer "${customer.name}"?`)) return;
    try {
      await deleteCustomer(id);
      router.push('/customers');
    } catch (err) {
      setError(err.message || 'Failed to archive customer');
    }
  };

  if (!isLoggedIn) {
    return (
      <Shell>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to view customer profiles.
        </Alert>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell user={profile?.name}>
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spinner />
          <p style={{ marginTop: 12, color: 'var(--muted)' }}>Loading profile...</p>
        </div>
      </Shell>
    );
  }

  if (!customer) {
    return (
      <Shell user={profile?.name}>
        <Alert tone="danger">
          {error || 'Customer not found.'}{' '}
          <Link href="/customers" style={{ fontWeight: 600 }}>
            Return to Directory
          </Link>
        </Alert>
      </Shell>
    );
  }

  return (
    <Shell user={profile?.name}>
      {/* Navigation Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
        <Link href="/customers" id="link-back-customers" style={{ textDecoration: 'none' }}>
          ← Customers Directory
        </Link>
        <span>/</span>
        <span style={{ color: 'var(--heading)', fontWeight: 600 }}>{customer.name}</span>
        {customer.isArchived && <Badge tone="danger">Archived</Badge>}
        {customer.mergedInto && <Badge tone="warning">Merged</Badge>}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {successMsg && <Alert tone="success">{successMsg}</Alert>}

      {/* Hero Header */}
      <Hero
        badges={[
          [customer.type === 'wholesale' ? 'Wholesale Customer' : 'Retail Customer', false],
          [customer.marketingOptIn ? 'Marketing Opted-In' : 'No Marketing', true],
        ]}
        title={customer.name}
        subtitle={`Phone: ${customer.phone || 'None'} | NIC: ${customer.nic || 'Not specified'}`}
        actions={
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button
              id="btn-edit-customer"
              variant="heroBtn"
              onClick={() => {
                setEditError('');
                setShowEditModal(true);
              }}
              style={{ minHeight: 44, padding: '0 20px', fontWeight: 600 }}
            >
              Edit Details
            </Button>
            {!customer.isArchived && (
              <Button
                id="btn-archive-customer-profile"
                variant="onDark"
                onClick={handleArchive}
                style={{ minHeight: 44, padding: '0 16px' }}
              >
                Archive Customer
              </Button>
            )}
          </div>
        }
        aside={[
          { label: 'Current Balance', value: money(customer.currentBalanceCents || 0) },
          { label: 'Loyalty Points', value: (customer.loyaltyPoints || 0).toLocaleString() },
        ]}
      />

      {/* Tabs Bar */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '2px solid var(--border)',
          paddingBottom: 0,
        }}
      >
        <button
          id="tab-btn-details"
          onClick={() => setActiveTab('details')}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'details' ? '3px solid var(--primary)' : '3px solid transparent',
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            color: activeTab === 'details' ? 'var(--primary)' : 'var(--muted)',
            marginBottom: -2,
            minHeight: 44,
          }}
        >
          Customer Details
        </button>
        <button
          id="tab-btn-history"
          onClick={() => setActiveTab('history')}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'history' ? '3px solid var(--primary)' : '3px solid transparent',
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            color: activeTab === 'history' ? 'var(--primary)' : 'var(--muted)',
            marginBottom: -2,
            minHeight: 44,
          }}
        >
          Purchase & POS History
        </button>
        <button
          id="tab-btn-loyalty"
          onClick={() => setActiveTab('loyalty')}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'loyalty' ? '3px solid var(--primary)' : '3px solid transparent',
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            color: activeTab === 'loyalty' ? 'var(--primary)' : 'var(--muted)',
            marginBottom: -2,
            minHeight: 44,
          }}
        >
          Loyalty Rewards
        </button>
      </div>

      {/* TAB 1: DETAILS */}
      {activeTab === 'details' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
          <Card title="Contact Information">
            <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 12, fontSize: 13 }}>
              <dt style={{ color: 'var(--muted)' }}>Full Name:</dt>
              <dd>
                <strong>{customer.name}</strong>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Phone (Full):</dt>
              <dd>
                <code>{customer.phone || '-'}</code>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>NIC Number:</dt>
              <dd>
                <code>{customer.nic || 'Not recorded'}</code>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Email:</dt>
              <dd>{customer.email || 'None'}</dd>
              <dt style={{ color: 'var(--muted)' }}>Address:</dt>
              <dd>{customer.address || 'None'}</dd>
              <dt style={{ color: 'var(--muted)' }}>Type:</dt>
              <dd>
                <Badge tone={customer.type === 'wholesale' ? 'warning' : 'neutral'}>
                  {customer.type === 'wholesale' ? 'Wholesale' : 'Retail'}
                </Badge>
              </dd>
            </dl>
          </Card>

          <Card title="Financial & Preferences">
            <dl style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 12, fontSize: 13 }}>
              <dt style={{ color: 'var(--muted)' }}>Current Balance:</dt>
              <dd>
                <strong style={{ color: customer.currentBalanceCents > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {money(customer.currentBalanceCents || 0)}
                </strong>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Credit Limit:</dt>
              <dd>{customer.creditLimitCents > 0 ? money(customer.creditLimitCents) : 'No credit limit set'}</dd>
              <dt style={{ color: 'var(--muted)' }}>Loyalty Points:</dt>
              <dd>
                <strong style={{ color: 'var(--primary)' }}>{(customer.loyaltyPoints || 0).toLocaleString()}</strong>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Marketing Opt-In:</dt>
              <dd>
                <Badge tone={customer.marketingOptIn ? 'success' : 'neutral'}>
                  {customer.marketingOptIn ? 'Subscribed' : 'Not Opted-In'}
                </Badge>
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Created At:</dt>
              <dd>{date(customer.createdAt)}</dd>
              <dt style={{ color: 'var(--muted)' }}>Tags:</dt>
              <dd>
                {customer.tags?.length > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {customer.tags.map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'var(--tint)',
                          color: 'var(--primary)',
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>No tags</span>
                )}
              </dd>
            </dl>
          </Card>

          {customer.notes && (
            <Card title="Internal Notes" style={{ gridColumn: '1 / -1' }}>
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--body)' }}>{customer.notes}</p>
            </Card>
          )}
        </div>
      )}

      {/* TAB 2: PURCHASE & POS HISTORY */}
      {activeTab === 'history' && (
        <div style={{ display: 'grid', gap: 18 }}>
          <Alert>
            <strong>Hardware & Repairs Info:</strong> Repair tickets and devices owned will appear in this history once
            the repair and inventory modules are deployed.
          </Alert>

          {/* Invoices */}
          <Card title="Sales Invoices">
            {!history?.invoices || history.invoices.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No invoices found for this customer.</p>
            ) : (
              <Table head={['Invoice #', 'Date', 'Status', 'Grand Total', 'Paid Amount']}>
                {history.invoices.map((inv) => (
                  <tr key={inv._id}>
                    <td>
                      <code>{inv.invoiceNumber}</code>
                    </td>
                    <td>{date(inv.createdAt)}</td>
                    <td>
                      <Badge tone={inv.status === 'completed' ? 'success' : 'neutral'}>{inv.status}</Badge>
                    </td>
                    <td>
                      <strong>{money(inv.grandTotalCents || 0)}</strong>
                    </td>
                    <td>{money(inv.totalPaidCents || 0)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {/* Payments */}
          <Card title="Payments Received">
            {!history?.payments || history.payments.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No payment records found.</p>
            ) : (
              <Table head={['Payment ID', 'Method', 'Amount', 'Date']}>
                {history.payments.map((p) => (
                  <tr key={p._id}>
                    <td>
                      <code>{String(p._id).slice(-8)}</code>
                    </td>
                    <td>
                      <Badge tone="neutral">{p.method}</Badge>
                    </td>
                    <td>
                      <strong>{money(p.amountCents || 0)}</strong>
                    </td>
                    <td>{date(p.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {/* Credit Notes & Installment Plans */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
            <Card title="Credit Notes & Returns">
              {!history?.creditNotes || history.creditNotes.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No credit notes.</p>
              ) : (
                <Table head={['Note #', 'Original Inv', 'Refund Amount']}>
                  {history.creditNotes.map((cn) => (
                    <tr key={cn._id}>
                      <td>
                        <code>{cn.creditNoteNumber}</code>
                      </td>
                      <td>{cn.originalInvoiceNumber || '-'}</td>
                      <td>
                        <strong>{money(cn.totalRefundCents || 0)}</strong>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Installment Plans">
              {!history?.installmentPlans || history.installmentPlans.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No installment plans.</p>
              ) : (
                <Table head={['Plan #', 'Financed', 'Remaining', 'Status']}>
                  {history.installmentPlans.map((ip) => (
                    <tr key={ip._id}>
                      <td>
                        <code>{ip.planNumber}</code>
                      </td>
                      <td>{money(ip.financedAmountCents || 0)}</td>
                      <td>{money(ip.remainingBalanceCents || 0)}</td>
                      <td>
                        <Badge tone={ip.status === 'completed' ? 'success' : 'warning'}>{ip.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* TAB 3: LOYALTY REWARDS */}
      {activeTab === 'loyalty' && (
        <div style={{ display: 'grid', gap: 18 }}>
          <StatGrid>
            <Stat
              label="Accumulated Points"
              value={(customer.loyaltyPoints || 0).toLocaleString()}
              helper="Available for POS checkout discounts"
            />
            <Stat
              label="Cash Redemption Value"
              value={money((customer.loyaltyPoints || 0) * 100)} // 1 point = 100 cents (1 LKR) by default
              helper="Calculated at base shop rate"
            />
          </StatGrid>

          <Card title="Loyalty Points Activity Log">
            {!history?.loyaltyTransactions || history.loyaltyTransactions.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No loyalty transactions recorded yet.</p>
            ) : (
              <Table head={['Date', 'Transaction Type', 'Points Change', 'Invoice Sale', 'Running Balance']}>
                {history.loyaltyTransactions.map((tx) => (
                  <tr key={tx._id}>
                    <td>{date(tx.date || tx.createdAt)}</td>
                    <td>
                      <Badge
                        tone={
                          tx.type === 'earn' || tx.type === 'installment_earn'
                            ? 'success'
                            : tx.type === 'redeem'
                            ? 'warning'
                            : 'danger'
                        }
                      >
                        {tx.type}
                      </Badge>
                    </td>
                    <td>
                      <strong
                        style={{
                          color:
                            tx.points > 0 && tx.type.includes('earn')
                              ? 'var(--success)'
                              : 'var(--danger)',
                        }}
                      >
                        {tx.points > 0 && tx.type.includes('earn') ? `+${tx.points}` : `-${tx.points}`}
                      </strong>
                    </td>
                    <td>{money(tx.amountCents || 0)}</td>
                    <td>{tx.balanceAfter?.toLocaleString() || '-'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}

      {/* MODAL: Edit Customer */}
      {showEditModal && (
        <ModalOverlay onClose={() => setShowEditModal(false)}>
          <Card title="Edit Customer Details" style={{ maxWidth: 540, width: '100%', margin: 'auto' }}>
            <form onSubmit={handleEditSubmit} style={{ display: 'grid', gap: 14 }}>
              {editError && <Alert tone="danger">{editError}</Alert>}

              <Field
                id="edit-customer-name"
                label="Full Name *"
                required
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field
                  id="edit-customer-phone"
                  label="Phone Number *"
                  required
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                />
                <Field
                  id="edit-customer-nic"
                  label="NIC Number"
                  value={editForm.nic}
                  onChange={(e) => setEditForm({ ...editForm, nic: e.target.value })}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field
                  id="edit-customer-email"
                  label="Email"
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                />
                <Field
                  id="edit-customer-type"
                  label="Customer Type"
                  as="select"
                  value={editForm.type}
                  onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}
                >
                  <option value="retail">Retail</option>
                  <option value="wholesale">Wholesale</option>
                </Field>
              </div>

              <Field
                id="edit-customer-address"
                label="Address"
                value={editForm.address}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
              />

              <Field
                id="edit-customer-tags"
                label="Tags (comma-separated)"
                value={editForm.tags}
                onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
              />

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  padding: '6px 0',
                }}
              >
                <input
                  id="edit-customer-marketing"
                  type="checkbox"
                  checked={editForm.marketingOptIn}
                  onChange={(e) => setEditForm({ ...editForm, marketingOptIn: e.target.checked })}
                  style={{ width: 20, height: 20, cursor: 'pointer' }}
                />
                <span>
                  <strong>Marketing Communications Opt-In</strong>
                </span>
              </label>

              <Field
                id="edit-customer-notes"
                label="Internal Notes"
                as="textarea"
                rows={3}
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Button
                  id="btn-cancel-edit"
                  type="button"
                  variant="secondary"
                  onClick={() => setShowEditModal(false)}
                  style={{ minHeight: 44, padding: '0 16px' }}
                >
                  Cancel
                </Button>
                <Button
                  id="btn-save-edit"
                  type="submit"
                  disabled={editBusy}
                  style={{ minHeight: 44, padding: '0 24px', fontWeight: 600 }}
                >
                  {editBusy ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </Card>
        </ModalOverlay>
      )}
    </Shell>
  );
}

function ModalOverlay({ children, onClose }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(16, 24, 40, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 9999,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function Shell({ children, user }) {
  return (
    <>
      <AppHeader chip="Customer Profile">
        <Link href="/customers" id="header-link-customers" style={{ fontWeight: 600 }}>
          ← Customer Directory
        </Link>
        <Link href="/" id="header-link-dashboard" style={{ fontWeight: 600 }}>
          Dashboard
        </Link>
        {user && <User name={user} />}
      </AppHeader>
      <main
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '24px 16px 48px',
          display: 'grid',
          gap: 18,
        }}
      >
        {children}
      </main>
    </>
  );
}
