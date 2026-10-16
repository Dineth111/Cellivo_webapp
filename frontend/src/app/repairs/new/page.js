'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  createRepairTicket,
  getCustomers,
  getRepairsConfig,
  getTechniciansWorkload,
  getAuthProfile,
  hasSession,
} from '../../../lib/api';
import {
  Alert,
  AppHeader,
  Button,
  Card,
  Field,
  Spinner,
  User,
} from '../../../components/ui';

// Luhn formula check on the client (15 digits)
function checkLuhn(imei) {
  if (!imei) return null;
  const cleaned = String(imei).replace(/\D/g, '');
  if (cleaned.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = parseInt(cleaned[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function validateRupeeAmount(val, fieldName, { required = false } = {}) {
  if (val === undefined || val === null || String(val).trim() === '') {
    if (required) return `${fieldName} is required.`;
    return null;
  }
  const s = String(val).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return `${fieldName} must be a valid positive amount with up to 2 decimal places.`;
  }
  const num = Number(s);
  if (isNaN(num) || num < 0) {
    return `${fieldName} cannot be negative.`;
  }
  return null;
}

function parseRupeeToCents(val) {
  if (val === undefined || val === null || String(val).trim() === '') return 0;
  const num = Number(String(val).trim());
  return isNaN(num) || num < 0 ? 0 : Math.round(num * 100);
}

const COMMON_ACCESSORIES = [
  'Charger',
  'Cable',
  'SIM Tray',
  'Protective Case',
  'Memory Card',
  'Original Box',
];

export default function NewRepairPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [warningMsg, setWarningMsg] = useState('');

  // Passcode storage configuration from server
  const [passcodeEnabled, setPasscodeEnabled] = useState(false);

  // Technicians list
  const [technicians, setTechnicians] = useState([]);

  // Customer selection mode: 'search' or 'create'
  const [customerMode, setCustomerMode] = useState('create');
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [customerSearchResults, setCustomerSearchResults] = useState([]);
  const [searchingCustomer, setSearchingCustomer] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);

  // Customer form fields (for new customer)
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerNic, setCustomerNic] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [duplicatePhoneWarning, setDuplicatePhoneWarning] = useState('');

  // Device fields
  const [deviceBrand, setDeviceBrand] = useState('');
  const [deviceModel, setDeviceModel] = useState('');
  const [deviceImei, setDeviceImei] = useState('');
  const [deviceSerial, setDeviceSerial] = useState('');
  const [deviceColour, setDeviceColour] = useState('');

  // Repair details
  const [accessories, setAccessories] = useState([]);
  const [customAccessory, setCustomAccessory] = useState('');
  const [conditionNotes, setConditionNotes] = useState('');
  const [faultDescription, setFaultDescription] = useState('');
  const [estimateRs, setEstimateRs] = useState('');
  const [advanceRs, setAdvanceRs] = useState('');
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState('cash');
  const [promisedDate, setPromisedDate] = useState('');
  const [devicePasscode, setDevicePasscode] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  useEffect(() => {
    if (!hasSession()) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }
    Promise.all([
      getAuthProfile().then((p) => setProfile(p.data)).catch(() => {}),
      getRepairsConfig().then((cfg) => setPasscodeEnabled(Boolean(cfg.data?.passcodeEnabled))).catch(() => setPasscodeEnabled(false)),
      getTechniciansWorkload().then((res) => setTechnicians(res.data || [])).catch(() => {}),
    ]).finally(() => {
      setLoading(false);
    });
  }, []);

  // Debounced duplicate phone check
  useEffect(() => {
    if (customerMode !== 'create' || !customerPhone || customerPhone.trim().length < 8) {
      Promise.resolve().then(() => setDuplicatePhoneWarning(''));
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await getCustomers({ search: customerPhone.trim() });
        const match = (res.data || []).find((c) => c.phone?.includes(customerPhone.trim()));
        if (match) {
          setDuplicatePhoneWarning(
            `Notice: A customer with phone number "${match.phone}" already exists (${match.name}). Continuing will create another ticket under this customer.`
          );
        } else {
          setDuplicatePhoneWarning('');
        }
      } catch {
        // Non-blocking
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [customerPhone, customerMode]);

  const handleSearchCustomers = async () => {
    if (!customerSearchQuery.trim()) return;
    setSearchingCustomer(true);
    try {
      const res = await getCustomers({ search: customerSearchQuery.trim() });
      setCustomerSearchResults(res.data || []);
    } catch (err) {
      setError(err.message || 'Error searching customers');
    } finally {
      setSearchingCustomer(false);
    }
  };

  const handleSelectCustomer = (c) => {
    setSelectedCustomer(c);
    setCustomerSearchResults([]);
    setCustomerSearchQuery('');
  };

  const toggleAccessory = (acc) => {
    setAccessories((prev) =>
      prev.includes(acc) ? prev.filter((item) => item !== acc) : [...prev, acc]
    );
  };

  const handleAddCustomAccessory = (e) => {
    e.preventDefault();
    if (customAccessory.trim() && !accessories.includes(customAccessory.trim())) {
      setAccessories([...accessories, customAccessory.trim()]);
      setCustomAccessory('');
    }
  };

  const imeiValidationStatus = () => {
    if (!deviceImei.trim()) return null;
    const isValid = checkLuhn(deviceImei.trim());
    if (isValid === true) {
      return { ok: true, message: 'Valid Luhn 15-digit IMEI checksum' };
    }
    return { ok: false, message: 'Invalid Luhn checksum (server requires valid 15-digit Luhn IMEI)' };
  };

  const imeiStatus = imeiValidationStatus();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setWarningMsg('');

    if (customerMode === 'search' && !selectedCustomer) {
      setError('Please search and select a customer, or switch to "Create New Customer".');
      return;
    }

    if (customerMode === 'create') {
      if (!customerName.trim()) {
        setError('Customer name is required.');
        return;
      }
      if (!customerPhone.trim()) {
        setError('Customer phone number is required.');
        return;
      }
    }

    if (!deviceBrand.trim()) {
      setError('Device brand is required.');
      return;
    }
    if (!deviceModel.trim()) {
      setError('Device model is required.');
      return;
    }
    if (!faultDescription.trim()) {
      setError('Fault description is required.');
      return;
    }

    // Client-side Luhn warning check
    if (deviceImei.trim() && imeiStatus && !imeiStatus.ok) {
      setError('Cannot submit: Device IMEI failed Luhn checksum validation.');
      return;
    }

    // Client-side rupee validation
    const estimateErr = validateRupeeAmount(estimateRs, 'Estimated repair cost');
    if (estimateErr) {
      setError(estimateErr);
      return;
    }
    const advanceErr = validateRupeeAmount(advanceRs, 'Advance deposit');
    if (advanceErr) {
      setError(advanceErr);
      return;
    }

    setSubmitting(true);

    try {
      const estimateCents = parseRupeeToCents(estimateRs);
      const advanceCents = parseRupeeToCents(advanceRs);

      const payload = {
        device: {
          brand: deviceBrand.trim(),
          model: deviceModel.trim(),
          imei: deviceImei.trim() || null,
          serial: deviceSerial.trim() || null,
          colour: deviceColour.trim() || null,
        },
        accessories,
        conditionNotes: conditionNotes.trim(),
        faultDescription: faultDescription.trim(),
        estimateCents,
        advanceCents,
        advancePaymentMethod,
        promisedDate: promisedDate || null,
        passcode: passcodeEnabled && devicePasscode ? devicePasscode.trim() : null,
        technicianId: technicianId || null,
        internalNotes: internalNotes.trim(),
      };

      if (customerMode === 'search') {
        payload.customerId = selectedCustomer._id;
      } else {
        payload.customer = {
          name: customerName.trim(),
          phone: customerPhone.trim(),
          nic: customerNic.trim(),
          email: customerEmail.trim(),
        };
      }

      const res = await createRepairTicket(payload);
      if (res.warning) {
        setWarningMsg(res.warning);
      }
      // Navigate directly to ticket details page
      router.push(`/repairs/${res.data._id}`);
    } catch (err) {
      setError(err.message || 'Failed to create repair ticket.');
      setSubmitting(false);
    }
  };

  if (!hasSession()) {
    return (
      <Shell>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to create a repair ticket.
        </Alert>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell user={profile?.name}>
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spinner />
          <p style={{ marginTop: 12, color: 'var(--secondary)' }}>Loading intake form...</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell user={profile?.name}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Link href="/repairs" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          ← Back to Repairs Board
        </Link>
      </div>

      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--heading)' }}>New Device Repair Intake</h1>
        <p style={{ color: 'var(--secondary)', fontSize: 13, marginTop: 4 }}>
          Log incoming device, customer details, diagnostic fault, and collect advance deposits.
        </p>
      </div>

      {error && (
        <Alert tone="danger">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button
              onClick={() => setError('')}
              style={{
                background: 'transparent',
                border: 0,
                color: 'inherit',
                fontWeight: 700,
                cursor: 'pointer',
                minHeight: 44,
                minWidth: 44,
              }}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {warningMsg && (
        <Alert tone="warning">
          <span>{warningMsg}</span>
        </Alert>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 20 }}>
        {/* Section 1: Customer Details */}
        <Card title="1. Customer Information">
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <Button
              type="button"
              variant={customerMode === 'create' ? undefined : 'secondary'}
              onClick={() => {
                setCustomerMode('create');
                setSelectedCustomer(null);
              }}
              style={{ minHeight: 44 }}
            >
              + Create New Customer
            </Button>
            <Button
              type="button"
              variant={customerMode === 'search' ? undefined : 'secondary'}
              onClick={() => setCustomerMode('search')}
              style={{ minHeight: 44 }}
            >
              Search Existing Customer
            </Button>
          </div>

          {customerMode === 'search' ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <Field
                  label="Search by Phone or Name"
                  value={customerSearchQuery}
                  onChange={(e) => setCustomerSearchQuery(e.target.value)}
                  placeholder="e.g. 0771234567 or Kasun"
                  style={{ flex: 1, minHeight: 44 }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleSearchCustomers}
                  disabled={searchingCustomer}
                  style={{ minHeight: 44, padding: '0 20px' }}
                >
                  {searchingCustomer ? 'Searching...' : 'Search'}
                </Button>
              </div>

              {selectedCustomer && (
                <div
                  style={{
                    background: 'var(--tint)',
                    border: '1px solid var(--border)',
                    padding: 14,
                    borderRadius: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: 15, color: 'var(--brand)' }}>{selectedCustomer.name}</strong>
                    <div style={{ fontSize: 13, color: 'var(--secondary)' }}>Phone: {selectedCustomer.phone}</div>
                    {selectedCustomer.nic && <div style={{ fontSize: 12, color: 'var(--muted)' }}>NIC: {selectedCustomer.nic}</div>}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSelectedCustomer(null)}
                    style={{ minHeight: 44 }}
                  >
                    Change
                  </Button>
                </div>
              )}

              {customerSearchResults.length > 0 && !selectedCustomer && (
                <div style={{ display: 'grid', gap: 8, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--label)' }}>Select Customer:</span>
                  {customerSearchResults.map((c) => (
                    <div
                      key={c._id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <strong>{c.name}</strong> · <span>{c.phone}</span>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => handleSelectCustomer(c)}
                        style={{ minHeight: 44 }}
                      >
                        Select
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              <Field
                label="Customer Name *"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Full name"
                required
                style={{ minHeight: 44 }}
              />

              <Field
                label="Phone Number *"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="e.g. 0771234567"
                required
                hint="Used for SMS progress notifications"
                style={{ minHeight: 44 }}
              />

              <Field
                label="National ID (NIC)"
                value={customerNic}
                onChange={(e) => setCustomerNic(e.target.value)}
                placeholder="Optional"
                style={{ minHeight: 44 }}
              />

              <Field
                label="Email Address"
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="Optional"
                style={{ minHeight: 44 }}
              />

              {duplicatePhoneWarning && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <Alert tone="warning">
                    <span>{duplicatePhoneWarning}</span>
                  </Alert>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Section 2: Device Details */}
        <Card title="2. Device Specifications">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <Field
              label="Brand *"
              value={deviceBrand}
              onChange={(e) => setDeviceBrand(e.target.value)}
              placeholder="e.g. Apple, Samsung, Xiaomi"
              required
              style={{ minHeight: 44 }}
            />

            <Field
              label="Model *"
              value={deviceModel}
              onChange={(e) => setDeviceModel(e.target.value)}
              placeholder="e.g. iPhone 13 Pro, Redmi Note 10"
              required
              style={{ minHeight: 44 }}
            />

            <div>
              <Field
                label="IMEI (15-digit Luhn)"
                value={deviceImei}
                onChange={(e) => setDeviceImei(e.target.value)}
                placeholder="15-digit IMEI number"
                hint="Validated with Luhn formula on client & server"
                style={{ minHeight: 44 }}
              />
              {imeiStatus && (
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    marginTop: 4,
                    color: imeiStatus.ok ? 'var(--success)' : 'var(--danger)',
                  }}
                  role="status"
                >
                  {imeiStatus.ok ? '✓ ' : '✗ '}
                  {imeiStatus.message}
                </div>
              )}
            </div>

            <Field
              label="Serial Number"
              value={deviceSerial}
              onChange={(e) => setDeviceSerial(e.target.value)}
              placeholder="Optional"
              style={{ minHeight: 44 }}
            />

            <Field
              label="Colour / Finish"
              value={deviceColour}
              onChange={(e) => setDeviceColour(e.target.value)}
              placeholder="e.g. Midnight Black, Pacific Blue"
              style={{ minHeight: 44 }}
            />

            {passcodeEnabled ? (
              <Field
                label="Device Passcode / PIN"
                value={devicePasscode}
                onChange={(e) => setDevicePasscode(e.target.value)}
                placeholder="e.g. 123456 or L-pattern"
                hint="Stored encrypted in database (AES-256-GCM)"
                style={{ minHeight: 44 }}
              />
            ) : (
              <div style={{ alignSelf: 'center', fontSize: 12, color: 'var(--muted)', paddingTop: 16 }}>
                <em>Device passcode storage is not configured on this server.</em>
              </div>
            )}
          </div>

          {/* Accessories Checkboxes */}
          <div style={{ marginTop: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>
              Accessories Left With Device
            </span>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {COMMON_ACCESSORIES.map((acc) => {
                const selected = accessories.includes(acc);
                return (
                  <button
                    key={acc}
                    type="button"
                    onClick={() => toggleAccessory(acc)}
                    style={{
                      border: selected ? '2px solid var(--primary)' : '1px solid var(--input-border)',
                      background: selected ? 'var(--tint)' : 'var(--surface)',
                      color: selected ? 'var(--brand)' : 'var(--heading)',
                      fontWeight: selected ? 700 : 500,
                      borderRadius: 999,
                      padding: '8px 16px',
                      fontSize: 13,
                      cursor: 'pointer',
                      minHeight: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                    aria-pressed={selected}
                  >
                    {selected ? '✓ ' : '+ '}
                    {acc}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Other accessory..."
                value={customAccessory}
                onChange={(e) => setCustomAccessory(e.target.value)}
                style={{
                  border: '1px solid var(--input-border)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  minHeight: 44,
                  fontSize: 13,
                  maxWidth: 240,
                }}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleAddCustomAccessory}
                style={{ minHeight: 44 }}
              >
                Add Accessory
              </Button>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <Field
              label="Physical Condition Notes"
              as="textarea"
              rows={2}
              value={conditionNotes}
              onChange={(e) => setConditionNotes(e.target.value)}
              placeholder="e.g. Scratched back glass, dent on top corner, missing volume button"
              hint="Document existing physical damage upon device receipt"
            />
          </div>
        </Card>

        {/* Section 3: Diagnostic & Financial Terms */}
        <Card title="3. Fault Diagnosis & Financial Terms">
          <Field
            label="Reported Fault / Customer Issue *"
            as="textarea"
            rows={3}
            value={faultDescription}
            onChange={(e) => setFaultDescription(e.target.value)}
            placeholder="Detailed description of fault reported by customer..."
            required
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 12 }}>
            <Field
              label="Initial Estimate (Rs)"
              type="number"
              step="any"
              min="0"
              value={estimateRs}
              onChange={(e) => setEstimateRs(e.target.value)}
              placeholder="0.00"
              hint="Tentative estimate quoted to customer"
              style={{ minHeight: 44 }}
            />

            <Field
              label="Advance Deposit (Rs)"
              type="number"
              step="any"
              min="0"
              value={advanceRs}
              onChange={(e) => setAdvanceRs(e.target.value)}
              placeholder="0.00"
              hint="Deposited advance money"
              style={{ minHeight: 44 }}
            />

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
              Advance Payment Method
              <select
                value={advancePaymentMethod}
                onChange={(e) => setAdvancePaymentMethod(e.target.value)}
                style={{
                  border: '1px solid var(--input-border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  minHeight: 44,
                  fontSize: 14,
                  background: 'var(--surface)',
                  color: 'var(--heading)',
                }}
              >
                <option value="cash">Cash (1010)</option>
                <option value="card">Card / POS (1020)</option>
                <option value="bank">Bank Transfer (1030)</option>
                <option value="cheque">Cheque (1040)</option>
              </select>
            </label>

            <Field
              label="Promised Completion Date"
              type="datetime-local"
              value={promisedDate}
              onChange={(e) => setPromisedDate(e.target.value)}
              hint="Due date shown on customer receipt"
              style={{ minHeight: 44 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
              Assign Technician
              <select
                value={technicianId}
                onChange={(e) => setTechnicianId(e.target.value)}
                style={{
                  border: '1px solid var(--input-border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  minHeight: 44,
                  fontSize: 14,
                  background: 'var(--surface)',
                  color: 'var(--heading)',
                }}
              >
                <option value="">-- Unassigned (Assign Later) --</option>
                {technicians.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name} ({t.activeTicketsCount ?? 0} active jobs)
                  </option>
                ))}
              </select>
            </label>

            <Field
              label="Internal Staff Notes"
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder="Visible only to workshop staff..."
              style={{ minHeight: 44 }}
            />
          </div>
        </Card>

        {/* Submit Actions */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <Button
            type="submit"
            disabled={submitting}
            style={{ minHeight: 48, padding: '0 24px', fontSize: 15, flex: '1 1 240px' }}
          >
            {submitting ? 'Creating Ticket...' : 'Create Ticket & Generate Job Card'}
          </Button>

          <Link href="/repairs" style={{ textDecoration: 'none', flex: '1 1 120px' }}>
            <Button type="button" variant="secondary" style={{ minHeight: 48, padding: '0 24px', width: '100%' }}>
              Cancel
            </Button>
          </Link>
        </div>
      </form>
    </Shell>
  );
}

function Shell({ children, user }) {
  return (
    <>
      <AppHeader chip="Repairs & Service">
        <Link href="/" id="link-dashboard" style={{ fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Dashboard
        </Link>
        <Link href="/repairs" id="link-repairs" style={{ fontWeight: 600, color: 'var(--brand)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Repairs
        </Link>
        <Link href="/pos" id="link-pos" style={{ fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Point of Sale
        </Link>
        {user && <User name={user} />}
      </AppHeader>
      <main
        style={{
          maxWidth: 1000,
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
