'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { getPublicRepairStatus } from '@/lib/api';

const STAGES_ORDER = [
  'Received',
  'Diagnosing',
  'In repair',
  'Quality check',
  'Ready',
  'Delivered',
];

const STAGE_LABELS = {
  Received: 'Device Received',
  Diagnosing: 'Diagnosing Problem',
  'Waiting approval': 'Awaiting Customer Approval',
  'Waiting parts': 'Waiting for Parts',
  'In repair': 'Repair in Progress',
  'Quality check': 'Quality Inspection',
  Ready: 'Ready for Pickup',
  Delivered: 'Delivered to Customer',
  Unrepairable: 'Device Unrepairable',
  Cancelled: 'Repair Cancelled',
};

function StatusContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get('token') || '';
  const ticketNoParam = searchParams.get('ticketNo') || '';

  const [token, setToken] = useState(tokenParam);
  const [ticketNo, setTicketNo] = useState(ticketNoParam);
  const [shopCode, setShopCode] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [useTokenMode, setUseTokenMode] = useState(Boolean(tokenParam));

  const [loading, setLoading] = useState(Boolean(tokenParam));
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');

  // Remove token from address bar after load with history.replaceState to avoid leakage
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      const url = new URL(window.location.href);
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        const cleanUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '');
        window.history.replaceState({}, '', cleanUrl);
      }
    }
  }, []);

  const handleLookup = async (params) => {
    setError('');
    setLoading(true);
    setTicket(null);

    try {
      const data = await getPublicRepairStatus(params);
      setTicket(data);
    } catch (err) {
      if (err.status === 429) {
        setError('Too many requests. Please wait a few minutes before trying again.');
      } else if (err.status === 403) {
        setError('This repair shop service is currently unavailable.');
      } else {
        setError('Repair ticket not found. Please verify the ticket/code, shop name, and phone digits.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch if token is in query
  useEffect(() => {
    if (!tokenParam) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const data = await getPublicRepairStatus({ token: tokenParam });
        if (active) setTicket(data);
      } catch (err) {
        if (!active) return;
        if (err.status === 429) {
          setError('Too many requests. Please wait a few minutes before trying again.');
        } else if (err.status === 403) {
          setError('This repair shop service is currently unavailable.');
        } else {
          setError('Repair ticket not found. Please verify the ticket number and phone number digits.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tokenParam]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (useTokenMode) {
      if (!token.trim()) {
        setError('Please enter a tracking token');
        return;
      }
      handleLookup({ token: token.trim() });
    } else {
      if (!ticketNo.trim() || phoneLast4.replace(/\D/g, '').length < 4) {
        setError('Please enter both ticket number/code and the last 4 digits of your phone');
        return;
      }
      handleLookup({
        ticketNo: ticketNo.trim(),
        shopCode: shopCode.trim() || undefined,
        phoneLast4: phoneLast4.replace(/\D/g, '').slice(-4),
      });
    }
  };

  const formatDate = (d) => {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const currentStageIndex = ticket ? STAGES_ORDER.indexOf(ticket.stage) : -1;
  const isTerminalSpecial = ticket && ['Unrepairable', 'Cancelled'].includes(ticket.stage);

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f8', padding: '24px 16px', fontFamily: 'inherit' }}>
      <head>
        <meta name="referrer" content="no-referrer" />
      </head>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {/* Branding Header */}
        <header style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px 0', color: '#111827' }}>
            {ticket ? ticket.shopName : 'Cellivo Repair Tracker'}
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>
            Live status & update tracker for your device repair
          </p>
        </header>

        {/* Lookup Card */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => { setUseTokenMode(false); setError(''); }}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: !useTokenMode ? '#2563eb' : '#d1d5db',
                background: !useTokenMode ? '#eff6ff' : '#fff',
                color: !useTokenMode ? '#1d4ed8' : '#4b5563',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              Ticket No + Phone
            </button>
            <button
              type="button"
              onClick={() => { setUseTokenMode(true); setError(''); }}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: useTokenMode ? '#2563eb' : '#d1d5db',
                background: useTokenMode ? '#eff6ff' : '#fff',
                color: useTokenMode ? '#1d4ed8' : '#4b5563',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              Tracking Token
            </button>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
            {!useTokenMode ? (
              <>
                <div>
                  <label htmlFor="ticketNo" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#374151' }}>
                    Tracking Code or Ticket Number
                  </label>
                  <input
                    id="ticketNo"
                    type="text"
                    value={ticketNo}
                    onChange={(e) => setTicketNo(e.target.value)}
                    placeholder="e.g. 8-char code (A1B2C3D4) or JOB-000001"
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      fontSize: 15,
                      boxSizing: 'border-box',
                      minHeight: 44,
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="shopCode" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#374151' }}>
                    Shop Name (Optional if using Tracking Code)
                  </label>
                  <input
                    id="shopCode"
                    type="text"
                    value={shopCode}
                    onChange={(e) => setShopCode(e.target.value)}
                    placeholder="e.g. Apex Cell Fix"
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      fontSize: 15,
                      boxSizing: 'border-box',
                      minHeight: 44,
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="phoneLast4" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#374151' }}>
                    Customer Phone (Last 4 digits)
                  </label>
                  <input
                    id="phoneLast4"
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={phoneLast4}
                    onChange={(e) => setPhoneLast4(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 1234"
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      fontSize: 15,
                      boxSizing: 'border-box',
                      minHeight: 44,
                    }}
                  />
                </div>
              </>
            ) : (
              <div>
                <label htmlFor="token" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#374151' }}>
                  Secure Tracking Token
                </label>
                <input
                  id="token"
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste tracking token from SMS or QR link"
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: 8,
                    border: '1px solid #d1d5db',
                    fontSize: 15,
                    boxSizing: 'border-box',
                    minHeight: 44,
                  }}
                />
              </div>
            )}

            {error && (
              <div
                style={{
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b',
                  padding: '10px 14px',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: 8,
                background: '#2563eb',
                color: '#fff',
                fontWeight: 700,
                fontSize: 15,
                border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                minHeight: 44,
              }}
            >
              {loading ? 'Checking Status...' : 'Track My Repair'}
            </button>
          </form>
        </div>

        {/* Ticket Details View */}
        {ticket && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'grid', gap: 20 }}>
            {/* Header / Basic Info */}
            <div style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Ticket</span>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#111827' }}>#{ticket.ticketNo}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Device</span>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>
                    {ticket.device?.brand} {ticket.device?.model}
                  </div>
                </div>
              </div>
            </div>

            {/* Current Stage Indicator */}
            <div style={{ background: '#f8fafc', padding: 16, borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>
                Current Status
              </div>
              <div style={{ fontSize: 18, fontWeight: 800, color: isTerminalSpecial ? '#dc2626' : '#2563eb' }}>
                {STAGE_LABELS[ticket.stage] || ticket.stage}
              </div>
              {ticket.estimatedCompletion && (
                <div style={{ fontSize: 13, color: '#475569', marginTop: 4 }}>
                  Estimated completion: <strong>{formatDate(ticket.estimatedCompletion)}</strong>
                </div>
              )}
            </div>

            {/* Stage Progress Bar (for standard flow) */}
            {!isTerminalSpecial && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>
                  Repair Progress
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                  {STAGES_ORDER.map((s, idx) => {
                    const isDone = currentStageIndex >= idx;
                    const isCurrent = currentStageIndex === idx;
                    return (
                      <div key={s} style={{ textAlign: 'center' }}>
                        <div
                          style={{
                            height: 8,
                            borderRadius: 4,
                            background: isCurrent ? '#2563eb' : isDone ? '#10b981' : '#e5e7eb',
                            marginBottom: 6,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: isCurrent ? 700 : 500,
                            color: isCurrent ? '#1d4ed8' : isDone ? '#047857' : '#9ca3af',
                            display: 'block',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {s}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Amount Due Card (for Ready / Delivered) */}
            {ticket.amountDue && (
              <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', padding: 16, borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#065f46', marginBottom: 8 }}>
                  Ready for Collection
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
                  <span style={{ color: '#047857' }}>Total Repair Bill:</span>
                  <strong>Rs. {((ticket.amountDue.totalCents || 0) / 100).toFixed(2)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, color: '#064e3b' }}>
                  <span>Balance Payable:</span>
                  <span>Rs. {((ticket.amountDue.balanceCents || 0) / 100).toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* Friendly Stage Timeline */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>
                Activity Timeline
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {(ticket.timeline || []).map((step, idx) => (
                  <div
                    key={`${step.stage}-${idx}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 13,
                      padding: '8px 12px',
                      background: '#f9fafb',
                      borderRadius: 6,
                      border: '1px solid #f3f4f6',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#1f2937' }}>
                      {STAGE_LABELS[step.stage] || step.stage}
                    </span>
                    <span style={{ color: '#6b7280', fontSize: 12 }}>
                      {formatDate(step.date)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PublicStatusPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading status tracker...</div>}>
      <StatusContent />
    </Suspense>
  );
}
