'use client';

import { useState, useMemo } from 'react';
import { Button, Field, Alert, Spinner, money } from '../ui';
import { closeDrawerSession } from '../../lib/posApi';
import styles from './CloseDrawerModal.module.css';

const DENOMINATIONS = [
  { label: 'Rs 5,000', value: 5000 },
  { label: 'Rs 1,000', value: 1000 },
  { label: 'Rs 500', value: 500 },
  { label: 'Rs 100', value: 100 },
  { label: 'Rs 50', value: 50 },
  { label: 'Rs 20', value: 20 },
  { label: 'Rs 10', value: 10 },
  { label: 'Coins', value: 1 },
];

export default function CloseDrawerModal({
  isOpen,
  onClose,
  session,
  onSuccess,
}) {
  const [counts, setCounts] = useState({});
  const [managerPin, setManagerPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [closedSession, setClosedSession] = useState(null);

  const countedCashCents = useMemo(() => {
    let totalCents = 0;
    for (const d of DENOMINATIONS) {
      const count = parseInt(counts[d.value] || 0, 10);
      if (count > 0) {
        totalCents += count * d.value * 100;
      }
    }
    return totalCents;
  }, [counts]);

  const expectedCashCents = session?.expectedCashCents || 0;
  const varianceCents = countedCashCents - expectedCashCents;
  const toleranceCents = 50000; // 500 LKR
  const requiresManagerPin = Math.abs(varianceCents) > toleranceCents;

  if (!isOpen) return null;

  const handleCountChange = (val, countStr) => {
    const num = Math.max(0, parseInt(countStr, 10) || 0);
    setCounts((prev) => ({
      ...prev,
      [val]: num,
    }));
  };

  const handleCloseSession = async (e) => {
    e.preventDefault();
    setError('');

    if (requiresManagerPin && !managerPin.trim()) {
      setError(`Variance of ${money(Math.abs(varianceCents))} exceeds tolerance of ${money(toleranceCents)}. Manager approval PIN required.`);
      return;
    }

    setLoading(true);
    try {
      const res = await closeDrawerSession({
        sessionId: session?._id,
        countedCashCents,
        denominations: counts,
        managerPin: requiresManagerPin ? managerPin.trim() : null,
      });

      setClosedSession(res);
      onSuccess?.(res);
    } catch (err) {
      setError(err.message || 'Failed to close drawer session.');
    } finally {
      setLoading(false);
    }
  };

  const handlePrintZReport = () => {
    window.print();
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="close-drawer-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="close-drawer-title">
            {closedSession ? 'Z-Report (Session Closed)' : 'Close Cash Drawer & Count'}
          </h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className={styles.body}>
          {error && <Alert tone="danger">{error}</Alert>}

          {closedSession ? (
            /* Z-Report View */
            <div className={styles.zReportBox}>
              <div className={styles.zReportHeader}>
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>CELLIVO POS - END OF DAY Z-REPORT</h3>
                <div>Report ID: {closedSession.zReport?.reportId}</div>
                <div>Terminal: {closedSession.terminalId}</div>
                <div>Closed At: {new Date(closedSession.closedAt).toLocaleString()}</div>
              </div>

              <div className={styles.zReportRow}>
                <span>Opening Float:</span>
                <span>{money(closedSession.openingFloatCents)}</span>
              </div>
              <div className={styles.zReportRow}>
                <span>Cash Sales:</span>
                <span>+{money(closedSession.cashSalesCents)}</span>
              </div>
              <div className={styles.zReportRow}>
                <span>Cash Refunds:</span>
                <span>-{money(closedSession.cashRefundsCents)}</span>
              </div>
              <div className={styles.zReportRow}>
                <span>Net Cash Sales:</span>
                <span>{money(closedSession.zReport?.netCashSalesCents || 0)}</span>
              </div>
              <div className={styles.zReportRow}>
                <span>Cash In (Pay-ins):</span>
                <span>+{money(closedSession.zReport?.cashInCents || 0)}</span>
              </div>
              <div className={styles.zReportRow}>
                <span>Cash Out (Pay-outs):</span>
                <span>-{money(closedSession.zReport?.cashOutCents || 0)}</span>
              </div>
              <hr style={{ border: 'none', borderTop: '1px dashed #000', margin: '8px 0' }} />
              <div className={styles.zReportRow}>
                <strong>Expected Cash:</strong>
                <strong>{money(closedSession.expectedCashCents)}</strong>
              </div>
              <div className={styles.zReportRow}>
                <strong>Counted Cash:</strong>
                <strong>{money(closedSession.countedCashCents)}</strong>
              </div>
              <div className={styles.zReportRow}>
                <strong>Variance:</strong>
                <strong>{money(closedSession.varianceCents)}</strong>
              </div>
              <div className={styles.zReportRow}>
                <span>Status:</span>
                <span>{closedSession.status.toUpperCase()}</span>
              </div>
              {closedSession.requiresApproval && (
                <div className={styles.zReportRow}>
                  <span>Manager Approval:</span>
                  <span>Verified</span>
                </div>
              )}
            </div>
          ) : (
            /* Drawer Count Form */
            <form onSubmit={handleCloseSession}>
              <div className={styles.reconciliationCards}>
                <div className={styles.card}>
                  <span className={styles.cardLabel}>Expected Cash</span>
                  <span className={styles.cardVal}>{money(expectedCashCents)}</span>
                </div>
                <div className={styles.card}>
                  <span className={styles.cardLabel}>Counted Cash</span>
                  <span className={styles.cardVal}>{money(countedCashCents)}</span>
                </div>
                <div className={styles.card}>
                  <span className={styles.cardLabel}>Variance</span>
                  <span
                    className={`${styles.cardVal} ${
                      varianceCents < 0
                        ? styles.varianceDanger
                        : varianceCents > 0
                        ? styles.varianceSuccess
                        : ''
                    }`}
                  >
                    {varianceCents > 0 ? '+' : ''}
                    {money(varianceCents)}
                  </span>
                </div>
              </div>

              {requiresManagerPin && (
                <Alert tone="warning">
                  Variance exceeds shop tolerance of {money(toleranceCents)}. Manager approval PIN is required to close this session.
                </Alert>
              )}

              <div>
                <h4 className={styles.sectionTitle}>Denomination Breakdown</h4>
                <div className={styles.denomGrid}>
                  {DENOMINATIONS.map((d) => {
                    const count = counts[d.value] || '';
                    const subtotalCents = (parseInt(count || 0, 10) || 0) * d.value * 100;
                    return (
                      <div key={d.value} className={styles.denomRow}>
                        <span className={styles.denomLabel}>{d.label}</span>
                        <input
                          type="number"
                          min="0"
                          placeholder="0"
                          className={styles.denomInput}
                          value={count}
                          onChange={(e) => handleCountChange(d.value, e.target.value)}
                        />
                        <span className={styles.denomSubtotal}>{money(subtotalCents)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {requiresManagerPin && (
                <div style={{ marginTop: 16 }}>
                  <Field label="Manager Approval PIN">
                    <input
                      type="password"
                      placeholder="Enter 4-digit Manager PIN"
                      value={managerPin}
                      onChange={(e) => setManagerPin(e.target.value)}
                      required
                    />
                  </Field>
                </div>
              )}

              <div className={styles.footer} style={{ padding: '16px 0 0 0' }}>
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={loading}>
                  {loading ? <Spinner /> : 'Close Drawer & Generate Z-Report'}
                </Button>
              </div>
            </form>
          )}
        </div>

        {closedSession && (
          <div className={styles.footer}>
            <Button variant="secondary" onClick={handlePrintZReport}>
              🖨 Print Z-Report
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
