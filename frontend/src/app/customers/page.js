'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  getCustomers,
  createCustomer,
  deleteCustomer,
  getCustomerDuplicates,
  mergeCustomers,
  importCustomersCsv,
  getLoyaltySettings,
  updateLoyaltySettings,
  getAuthProfile,
  hasSession,
} from '../../lib/api';
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
  money,
} from '../../components/ui';

export default function CustomersPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Search & Filter state
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [archivedFilter, setArchivedFilter] = useState(false);
  const [page, setPage] = useState(1);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDuplicatesModal, setShowDuplicatesModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showLoyaltyModal, setShowLoyaltyModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);

  // Data for modals
  const [duplicateGroups, setDuplicateGroups] = useState([]);
  const [mergeSource, setMergeSource] = useState(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [duplicateConflict, setDuplicateConflict] = useState(null);

  // New Customer Form State
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    nic: '',
    email: '',
    address: '',
    type: 'retail',
    tags: '',
    marketingOptIn: false, // Default is false
    notes: '',
  });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');

  // CSV Import State
  const [csvContent, setCsvContent] = useState('');
  const [importErrors, setImportErrors] = useState([]);
  const [importBusy, setImportBusy] = useState(false);

  // Loyalty Settings State
  const [loyaltySettings, setLoyaltySettingsData] = useState({
    pointsPerHundredRupees: 1,
    valuePerPointCents: 100,
    minRedemptionPoints: 100,
    expiryDays: 365,
  });
  const [loyaltyBusy, setLoyaltyBusy] = useState(false);

  const fetchCustomerList = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getCustomers({
        search,
        type: typeFilter,
        archived: archivedFilter ? 'true' : 'false',
        page,
        limit: 25,
      });
      setCustomers(res.data || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [search, typeFilter, archivedFilter, page]);

  useEffect(() => {
    if (!hasSession()) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }
    let ignore = false;
    getAuthProfile()
      .then((p) => {
        if (!ignore) setProfile(p.data);
      })
      .catch(() => {});
    Promise.resolve().then(() => {
      if (!ignore) fetchCustomerList();
    });
    return () => {
      ignore = true;
    };
  }, [fetchCustomerList]);

  // Handle Create Customer submit
  const handleCreateCustomer = async (e) => {
    e.preventDefault();
    setFormBusy(true);
    setFormError('');
    setDuplicateConflict(null);

    const payload = {
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      nic: formData.nic.trim(),
      email: formData.email.trim(),
      address: formData.address.trim(),
      type: formData.type,
      tags: formData.tags ? formData.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      marketingOptIn: formData.marketingOptIn,
      notes: formData.notes.trim(),
    };

    try {
      await createCustomer(payload);
      setSuccessMsg('Customer created successfully.');
      setShowCreateModal(false);
      setFormData({
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
      fetchCustomerList();
    } catch (err) {
      if (err.code === 'DUPLICATE_PHONE' && err.data) {
        setDuplicateConflict(err.data);
      } else {
        setFormError(err.message || 'Could not create customer.');
      }
    } finally {
      setFormBusy(false);
    }
  };

  // Open Duplicates Modal
  const handleOpenDuplicates = async () => {
    setError('');
    try {
      const res = await getCustomerDuplicates();
      setDuplicateGroups(res.data || []);
      setShowDuplicatesModal(true);
    } catch (err) {
      setError(err.message || 'Failed to scan duplicates');
    }
  };

  // Open Loyalty Settings Modal
  const handleOpenLoyalty = async () => {
    setError('');
    try {
      const res = await getLoyaltySettings();
      if (res.data) {
        setLoyaltySettingsData({
          pointsPerHundredRupees: res.data.pointsPerHundredRupees ?? 1,
          valuePerPointCents: res.data.valuePerPointCents ?? 100,
          minRedemptionPoints: res.data.minRedemptionPoints ?? 100,
          expiryDays: res.data.expiryDays ?? 365,
        });
      }
      setShowLoyaltyModal(true);
    } catch (err) {
      setError(err.message || 'Failed to load loyalty settings');
    }
  };

  // Save Loyalty Settings
  const handleSaveLoyalty = async (e) => {
    e.preventDefault();
    setLoyaltyBusy(true);
    setError('');
    try {
      await updateLoyaltySettings(loyaltySettings);
      setSuccessMsg('Loyalty settings updated successfully.');
      setShowLoyaltyModal(false);
    } catch (err) {
      setError(err.message || 'Failed to update loyalty settings');
    } finally {
      setLoyaltyBusy(false);
    }
  };

  // Open Merge Modal from Duplicates or direct
  const startMerge = (sourceCust) => {
    setMergeSource(sourceCust);
    setMergeTargetId('');
    setShowMergeModal(true);
  };

  const handleMergeSubmit = async (e) => {
    e.preventDefault();
    if (!mergeSource || !mergeTargetId) return;
    setFormBusy(true);
    setError('');
    try {
      await mergeCustomers(mergeSource._id, mergeTargetId);
      setSuccessMsg('Customers merged successfully.');
      setShowMergeModal(false);
      setShowDuplicatesModal(false);
      fetchCustomerList();
    } catch (err) {
      setError(err.message || 'Merge failed.');
    } finally {
      setFormBusy(false);
    }
  };

  // Handle CSV Import
  const handleImportSubmit = async (e) => {
    e.preventDefault();
    setImportBusy(true);
    setImportErrors([]);
    try {
      const res = await importCustomersCsv(csvContent);
      setSuccessMsg(res.message || `Imported ${res.count} customers.`);
      setShowImportModal(false);
      setCsvContent('');
      fetchCustomerList();
    } catch (err) {
      if (err.data?.errors) {
        setImportErrors(err.data.errors);
      } else {
        setImportErrors([{ row: '-', field: '-', message: err.message }]);
      }
    } finally {
      setImportBusy(false);
    }
  };

  // Archive Customer
  const handleArchive = async (id, name) => {
    if (!window.confirm(`Are you sure you want to archive customer "${name}"?`)) return;
    try {
      await deleteCustomer(id);
      setSuccessMsg(`Customer "${name}" archived.`);
      fetchCustomerList();
    } catch (err) {
      setError(err.message || 'Failed to archive customer.');
    }
  };

  if (!hasSession()) {
    return (
      <Shell>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to view and manage customers.
        </Alert>
      </Shell>
    );
  }

  const isOwner = profile?.role?.key === 'owner';

  return (
    <Shell user={profile?.name}>
      {error && (
        <Alert tone="danger">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <Button variant="secondary" onClick={() => setError('')} style={{ minHeight: 32, padding: '4px 10px' }}>
              Dismiss
            </Button>
          </div>
        </Alert>
      )}

      {successMsg && (
        <Alert tone="success">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{successMsg}</span>
            <Button variant="secondary" onClick={() => setSuccessMsg('')} style={{ minHeight: 32, padding: '4px 10px' }}>
              Dismiss
            </Button>
          </div>
        </Alert>
      )}

      {/* Hero Banner */}
      <Hero
        badges={[['Customer Directory', false], ['CRM & POS F-13', true]]}
        title="Customers & Relations"
        subtitle="Manage client accounts, credit balances, loyalty points, and purchase histories."
        actions={
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button
              id="btn-new-customer"
              variant="heroBtn"
              onClick={() => {
                setFormError('');
                setDuplicateConflict(null);
                setShowCreateModal(true);
              }}
              style={{ minHeight: 44, padding: '0 20px', fontWeight: 600 }}
            >
              + New Customer
            </Button>
            <Button
              id="btn-import-csv"
              variant="onDark"
              onClick={() => {
                setImportErrors([]);
                setShowImportModal(true);
              }}
              style={{ minHeight: 44, padding: '0 16px' }}
            >
              Import CSV
            </Button>
            <Button
              id="btn-scan-duplicates"
              variant="onDark"
              onClick={handleOpenDuplicates}
              style={{ minHeight: 44, padding: '0 16px' }}
            >
              Find Duplicates
            </Button>
            <Button
              id="btn-loyalty-settings"
              variant="onDark"
              onClick={handleOpenLoyalty}
              style={{ minHeight: 44, padding: '0 16px' }}
            >
              Loyalty Rules
            </Button>
          </div>
        }
        aside={[
          { label: 'Total in System', value: total.toLocaleString() },
          { label: 'Showing Page', value: page.toString() },
        ]}
      />

      {/* Filter and Search Bar */}
      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <Field
              id="customer-search-input"
              label="Search customers"
              placeholder="Name, phone (+94 / 07x), NIC, or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ width: 140 }}>
            <Field
              id="customer-type-filter"
              label="Type"
              as="select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All Types</option>
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
            </Field>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', height: 44, paddingBottom: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500 }}>
              <input
                id="customer-archived-checkbox"
                type="checkbox"
                checked={archivedFilter}
                onChange={(e) => setArchivedFilter(e.target.checked)}
                style={{ width: 18, height: 18, cursor: 'pointer' }}
              />
              Show Archived
            </label>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button
              id="btn-refresh-customers"
              variant="secondary"
              onClick={fetchCustomerList}
              disabled={loading}
              style={{ minHeight: 44, minWidth: 44 }}
            >
              {loading ? <Spinner /> : 'Refresh'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Customers List Table */}
      <Card>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spinner />
            <p style={{ marginTop: 12, color: 'var(--muted)' }}>Loading customers...</p>
          </div>
        ) : customers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--heading)' }}>No customers found</p>
            <p style={{ color: 'var(--muted)', marginTop: 4 }}>
              Try adjusting your search criteria or add a new customer record.
            </p>
          </div>
        ) : (
          <>
            <Table head={['Customer', 'Phone', 'NIC', 'Type', 'Credit Balance', 'Loyalty Points', 'Opt-in', 'Actions']}>
              {customers.map((c) => (
                <tr key={c._id}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <Link
                        href={`/customers/${c._id}`}
                        id={`link-cust-${c._id}`}
                        style={{ fontWeight: 600, fontSize: 14, textDecoration: 'none' }}
                      >
                        {c.name}
                      </Link>
                      {c.email && <small style={{ color: 'var(--muted)' }}>{c.email}</small>}
                      {c.tags?.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                          {c.tags.map((t) => (
                            <span
                              key={t}
                              style={{
                                fontSize: 11,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: 'var(--tint)',
                                color: 'var(--primary)',
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    <code>{c.phone || '-'}</code>
                  </td>
                  <td>
                    <code>{c.nic || '-'}</code>
                  </td>
                  <td>
                    <Badge tone={c.type === 'wholesale' ? 'warning' : 'neutral'}>
                      {c.type === 'wholesale' ? 'Wholesale' : 'Retail'}
                    </Badge>
                  </td>
                  <td>
                    <strong style={{ color: c.currentBalanceCents > 0 ? 'var(--danger)' : 'inherit' }}>
                      {money(c.currentBalanceCents || 0)}
                    </strong>
                    {c.creditLimitCents > 0 && (
                      <div>
                        <small style={{ color: 'var(--muted)' }}>Limit: {money(c.creditLimitCents)}</small>
                      </div>
                    )}
                  </td>
                  <td>
                    <span style={{ fontWeight: 600, color: 'var(--primary)' }}>
                      {(c.loyaltyPoints || 0).toLocaleString()} pts
                    </span>
                  </td>
                  <td>
                    <Badge tone={c.marketingOptIn ? 'success' : 'neutral'}>
                      {c.marketingOptIn ? 'Opted In' : 'No'}
                    </Badge>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Link href={`/customers/${c._id}`}>
                        <Button
                          id={`btn-view-${c._id}`}
                          variant="secondary"
                          style={{ minHeight: 36, padding: '4px 10px', fontSize: 13 }}
                        >
                          View
                        </Button>
                      </Link>
                      {!c.isArchived && (
                        <Button
                          id={`btn-archive-${c._id}`}
                          variant="danger"
                          onClick={() => handleArchive(c._id, c.name)}
                          style={{ minHeight: 36, padding: '4px 10px', fontSize: 13 }}
                        >
                          Archive
                        </Button>
                      )}
                      {isOwner && !c.isArchived && (
                        <Button
                          id={`btn-merge-start-${c._id}`}
                          variant="secondary"
                          onClick={() => startMerge(c)}
                          style={{ minHeight: 36, padding: '4px 10px', fontSize: 13 }}
                          title="Merge customer into another"
                        >
                          Merge…
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 18,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
              }}
            >
              <span style={{ color: 'var(--muted)' }}>
                Showing {customers.length} of {total} customer(s)
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  id="btn-prev-page"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  style={{ minHeight: 36, padding: '0 14px' }}
                >
                  Previous
                </Button>
                <Button
                  id="btn-next-page"
                  variant="secondary"
                  disabled={customers.length < 25 || page * 25 >= total}
                  onClick={() => setPage((p) => p + 1)}
                  style={{ minHeight: 36, padding: '0 14px' }}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* MODAL: Create Customer */}
      {showCreateModal && (
        <ModalOverlay onClose={() => setShowCreateModal(false)}>
          <Card title="Add New Customer" style={{ maxWidth: 540, width: '100%', margin: 'auto' }}>
            <form onSubmit={handleCreateCustomer} style={{ display: 'grid', gap: 14 }}>
              {formError && <Alert tone="danger">{formError}</Alert>}

              {duplicateConflict && (
                <Alert tone="warning">
                  <div style={{ display: 'grid', gap: 6 }}>
                    <strong>A customer with this phone number already exists:</strong>
                    <div>
                      <strong>{duplicateConflict.name}</strong> ({duplicateConflict.phone})
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <Link href={`/customers/${duplicateConflict._id}`}>
                        <Button variant="secondary" style={{ minHeight: 36, padding: '4px 12px' }}>
                          View Existing Record
                        </Button>
                      </Link>
                    </div>
                  </div>
                </Alert>
              )}

              <Field
                id="input-customer-name"
                label="Full Name *"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Kasun Silva"
              />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field
                  id="input-customer-phone"
                  label="Phone Number * (07x or +94)"
                  required
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="0771234567"
                />
                <Field
                  id="input-customer-nic"
                  label="NIC Number"
                  value={formData.nic}
                  onChange={(e) => setFormData({ ...formData, nic: e.target.value })}
                  placeholder="199512345678 or 951234567V"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field
                  id="input-customer-email"
                  label="Email Address"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="client@example.com"
                />
                <Field
                  id="select-customer-type"
                  label="Customer Type"
                  as="select"
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                >
                  <option value="retail">Retail</option>
                  <option value="wholesale">Wholesale</option>
                </Field>
              </div>

              <Field
                id="input-customer-address"
                label="Address"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="No. 12, Galle Road, Colombo"
              />

              <Field
                id="input-customer-tags"
                label="Tags (comma-separated)"
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="vip, credit, frequent"
              />

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  padding: '8px 0',
                  userSelect: 'none',
                }}
              >
                <input
                  id="checkbox-customer-marketing"
                  type="checkbox"
                  checked={formData.marketingOptIn}
                  onChange={(e) => setFormData({ ...formData, marketingOptIn: e.target.checked })}
                  style={{ width: 20, height: 20, cursor: 'pointer' }}
                />
                <span>
                  <strong>Marketing Communications Opt-In</strong> (Default: off)
                </span>
              </label>

              <Field
                id="input-customer-notes"
                label="Internal Notes"
                as="textarea"
                rows={2}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Special delivery notes or credit preferences..."
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Button
                  id="btn-cancel-create"
                  type="button"
                  variant="secondary"
                  onClick={() => setShowCreateModal(false)}
                  style={{ minHeight: 44, padding: '0 16px' }}
                >
                  Cancel
                </Button>
                <Button
                  id="btn-submit-create"
                  type="submit"
                  disabled={formBusy}
                  style={{ minHeight: 44, padding: '0 24px', fontWeight: 600 }}
                >
                  {formBusy ? 'Saving…' : 'Save Customer'}
                </Button>
              </div>
            </form>
          </Card>
        </ModalOverlay>
      )}

      {/* MODAL: Duplicates Scanner & Resolver */}
      {showDuplicatesModal && (
        <ModalOverlay onClose={() => setShowDuplicatesModal(false)}>
          <Card title="Detected Customer Duplicates" style={{ maxWidth: 720, width: '100%', margin: 'auto' }}>
            <p style={{ color: 'var(--muted)', marginBottom: 14 }}>
              Grouping active customers sharing the same normalised phone number, NIC, or email address.
            </p>

            {duplicateGroups.length === 0 ? (
              <Alert tone="success">No potential duplicates detected across active customer records.</Alert>
            ) : (
              <div style={{ display: 'grid', gap: 16, maxHeight: '60vh', overflowY: 'auto' }}>
                {duplicateGroups.map((grp, idx) => (
                  <div
                    key={`${grp.reason}-${idx}`}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 14,
                      background: 'var(--surface)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <Badge tone="warning">
                        {grp.reason === 'duplicate_phone'
                          ? `Same Phone (${grp.matchedKey})`
                          : grp.reason === 'duplicate_nic'
                          ? `Same NIC (${grp.matchedKey})`
                          : `Same Email (${grp.matchedKey})`}
                      </Badge>
                      <small style={{ color: 'var(--muted)' }}>{grp.count} customer records</small>
                    </div>

                    <Table head={['Name', 'Phone', 'NIC', 'Balance', 'Points', 'Action']}>
                      {grp.customers.map((c) => (
                        <tr key={c._id}>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          <td>
                            <code>{c.phone}</code>
                          </td>
                          <td>
                            <code>{c.nic || '-'}</code>
                          </td>
                          <td>{money(c.currentBalanceCents || 0)}</td>
                          <td>{(c.loyaltyPoints || 0).toLocaleString()}</td>
                          <td>
                            {isOwner && (
                              <Button
                                id={`btn-merge-source-${c._id}`}
                                variant="secondary"
                                onClick={() => startMerge(c)}
                                style={{ minHeight: 34, padding: '2px 8px', fontSize: 12 }}
                              >
                                Merge This…
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <Button
                id="btn-close-duplicates"
                variant="secondary"
                onClick={() => setShowDuplicatesModal(false)}
                style={{ minHeight: 44, padding: '0 20px' }}
              >
                Close
              </Button>
            </div>
          </Card>
        </ModalOverlay>
      )}

      {/* MODAL: Merge Customers */}
      {showMergeModal && mergeSource && (
        <ModalOverlay onClose={() => setShowMergeModal(false)}>
          <Card title="Merge Customer Records (Owner Only)" style={{ maxWidth: 540, width: '100%', margin: 'auto' }}>
            <form onSubmit={handleMergeSubmit} style={{ display: 'grid', gap: 14 }}>
              <Alert tone="warning">
                <strong>Attention:</strong> Merging is permanent and cannot be undone.
                <ul style={{ paddingLeft: 18, marginTop: 6, fontSize: 13 }}>
                  <li>Invoices, installment plans, and loyalty logs will be moved to the destination customer.</li>
                  <li>Original invoice customer snapshots remain unchanged for legal compliance.</li>
                  <li>The source record will be archived with remaining balance and loyalty points combined.</li>
                </ul>
              </Alert>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block' }}>
                  SOURCE RECORD (Will be archived)
                </label>
                <div
                  style={{
                    padding: 10,
                    background: 'var(--danger-bg)',
                    borderRadius: 6,
                    marginTop: 4,
                    color: 'var(--danger)',
                  }}
                >
                  <strong>{mergeSource.name}</strong> ({mergeSource.phone})
                  <div>
                    Balance: {money(mergeSource.currentBalanceCents || 0)} | Points:{' '}
                    {(mergeSource.loyaltyPoints || 0).toLocaleString()}
                  </div>
                </div>
              </div>

              <Field
                id="select-merge-target"
                label="Target Customer ID *"
                as="select"
                required
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
              >
                <option value="">Select target customer...</option>
                {customers
                  .filter((c) => c._id !== mergeSource._id && !c.isArchived)
                  .map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name} ({c.phone}) - {money(c.currentBalanceCents || 0)}
                    </option>
                  ))}
              </Field>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                <Button
                  id="btn-cancel-merge"
                  type="button"
                  variant="secondary"
                  onClick={() => setShowMergeModal(false)}
                  style={{ minHeight: 44, padding: '0 16px' }}
                >
                  Cancel
                </Button>
                <Button
                  id="btn-confirm-merge"
                  type="submit"
                  variant="danger"
                  disabled={formBusy || !mergeTargetId}
                  style={{ minHeight: 44, padding: '0 24px', fontWeight: 600 }}
                >
                  {formBusy ? 'Merging…' : 'Confirm & Execute Merge'}
                </Button>
              </div>
            </form>
          </Card>
        </ModalOverlay>
      )}

      {/* MODAL: CSV Import */}
      {showImportModal && (
        <ModalOverlay onClose={() => setShowImportModal(false)}>
          <Card title="Import Customers via CSV" style={{ maxWidth: 640, width: '100%', margin: 'auto' }}>
            <form onSubmit={handleImportSubmit} style={{ display: 'grid', gap: 14 }}>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                Paste CSV data below or upload an RFC 4180 file. Format requires header row with <code>name</code> and{' '}
                <code>phone</code>. Maximum 2 MB / 5,000 rows. Operation is strictly all-or-nothing.
              </p>

              <div
                style={{
                  background: 'var(--tint)',
                  padding: 8,
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'monospace',
                }}
              >
                name,phone,email,nic,type,tags,marketing_opt_in
                <br />
                Nimal Silva,0771234567,nimal@test.lk,199012345678,retail,&quot;vip, cash&quot;,false
              </div>

              <Field
                id="textarea-csv-content"
                label="CSV Data"
                as="textarea"
                rows={8}
                required
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                placeholder="name,phone,email,nic,type,tags,marketing_opt_in..."
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />

              {importErrors.length > 0 && (
                <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                  <Alert tone="danger">
                    <strong>Import Rejected ({importErrors.length} errors found):</strong>
                    <ul style={{ paddingLeft: 18, marginTop: 6, fontSize: 12 }}>
                      {importErrors.map((err, i) => (
                        <li key={i}>
                          Row {err.row} [{err.field}]: {err.message}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Button
                  id="btn-cancel-import"
                  type="button"
                  variant="secondary"
                  onClick={() => setShowImportModal(false)}
                  style={{ minHeight: 44, padding: '0 16px' }}
                >
                  Cancel
                </Button>
                <Button
                  id="btn-submit-import"
                  type="submit"
                  disabled={importBusy || !csvContent.trim()}
                  style={{ minHeight: 44, padding: '0 24px', fontWeight: 600 }}
                >
                  {importBusy ? 'Validating & Importing…' : 'Import Customers'}
                </Button>
              </div>
            </form>
          </Card>
        </ModalOverlay>
      )}

      {/* MODAL: Loyalty Settings */}
      {showLoyaltyModal && (
        <ModalOverlay onClose={() => setShowLoyaltyModal(false)}>
          <Card title="Loyalty Program Settings" style={{ maxWidth: 480, width: '100%', margin: 'auto' }}>
            <form onSubmit={handleSaveLoyalty} style={{ display: 'grid', gap: 14 }}>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                Configure rules for points earning and redemption at the checkout POS counter.
              </p>

              <Field
                id="input-points-per-hundred"
                label="Points earned per 100 LKR spent"
                type="number"
                min="0"
                required
                value={loyaltySettings.pointsPerHundredRupees}
                onChange={(e) =>
                  setLoyaltySettingsData({
                    ...loyaltySettings,
                    pointsPerHundredRupees: Number(e.target.value),
                  })
                }
                hint="Default is 1 point per Rs 100 spent on paid sales."
              />

              <Field
                id="input-value-per-point"
                label="Value per point in cents (100 = 1 LKR)"
                type="number"
                min="0"
                required
                value={loyaltySettings.valuePerPointCents}
                onChange={(e) =>
                  setLoyaltySettingsData({
                    ...loyaltySettings,
                    valuePerPointCents: Number(e.target.value),
                  })
                }
                hint="Value credited when customer redeems 1 point."
              />

              <Field
                id="input-min-redemption-points"
                label="Minimum points to redeem"
                type="number"
                min="0"
                required
                value={loyaltySettings.minRedemptionPoints}
                onChange={(e) =>
                  setLoyaltySettingsData({
                    ...loyaltySettings,
                    minRedemptionPoints: Number(e.target.value),
                  })
                }
                hint="Minimum balance needed before redemption is allowed."
              />

              <Field
                id="input-expiry-days"
                label="Points Expiry Period (days)"
                type="number"
                min="0"
                required
                value={loyaltySettings.expiryDays}
                onChange={(e) =>
                  setLoyaltySettingsData({
                    ...loyaltySettings,
                    expiryDays: Number(e.target.value),
                  })
                }
                hint="Validity period for loyalty points."
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Button
                  id="btn-cancel-loyalty"
                  type="button"
                  variant="secondary"
                  onClick={() => setShowLoyaltyModal(false)}
                  style={{ minHeight: 44, padding: '0 16px' }}
                >
                  Cancel
                </Button>
                <Button
                  id="btn-submit-loyalty"
                  type="submit"
                  disabled={loyaltyBusy}
                  style={{ minHeight: 44, padding: '0 24px', fontWeight: 600 }}
                >
                  {loyaltyBusy ? 'Saving…' : 'Save Rules'}
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
      <AppHeader chip="CRM Customers">
        <Link href="/" id="link-dashboard" style={{ fontWeight: 600 }}>
          Dashboard
        </Link>
        <Link href="/pos" id="link-pos" style={{ fontWeight: 600 }}>
          Point of Sale
        </Link>
        {user && <User name={user} />}
      </AppHeader>
      <main
        style={{
          maxWidth: 1140,
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
