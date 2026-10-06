'use client';

import { useState, useMemo } from 'react';
import { Button, Alert, money } from '../ui';
import styles from './PaymentModal.module.css';

const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'card', label: 'Card', icon: '💳' },
  { id: 'bank_transfer', label: 'Bank Transfer', icon: '🏦' },
  { id: 'cheque', label: 'Cheque', icon: '📝' },
  { id: 'credit', label: 'Store Credit', icon: '📋' },
  { id: 'loyalty_points', label: 'Points', icon: '⭐' },
];

export default function PaymentModal({
  isOpen,
  onClose,
  totals,
  customer,
  onSubmitCheckout,
  onSuccess,
  isOnline = true,
}) {
  const [selectedMethod, setSelectedMethod] = useState('cash');
  const [tenderAmount, setTenderAmount] = useState('');
  const [payments, setPayments] = useState([]);
  const [reference, setReference] = useState('');
  const [printReceipt, setPrintReceipt] = useState(true);
  const [smsReceipt, setSmsReceipt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const grandTotalCents = totals?.grandTotalCents || 0;

  // Total paid across split payments
  const totalPaidCents = useMemo(() => {
    return payments.reduce((sum, p) => sum + p.amountCents, 0);
  }, [payments]);

  // Remaining due to cover invoice
  const remainingDueCents = Math.max(0, grandTotalCents - totalPaidCents);

  // Change due (only applies if total paid exceeds total, e.g. for cash)
  const changeDueCents = Math.max(0, totalPaidCents - grandTotalCents);

  if (!isOpen) return null;

  const handleAddPayment = () => {
    setError('');
    let amt = Math.round(Number(tenderAmount) * 100);
    if (isNaN(amt) || amt <= 0) {
      if (remainingDueCents > 0) {
        amt = remainingDueCents;
      } else {
        setError('Please enter a valid tender amount.');
        return;
      }
    }

    setPayments((prev) => [
      ...prev,
      {
        id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: selectedMethod,
        amountCents: amt,
        reference: reference.trim() || undefined,
      },
    ]);
    setTenderAmount('');
    setReference('');
  };

  const handleRemovePayment = (id) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
  };

  const handleQuickCash = (cents) => {
    setTenderAmount((cents / 100).toFixed(2));
  };

  const handleCompleteSale = async () => {
    setError('');
    const effectivePayments = [...payments];

    // If no payments explicitly added to the list, auto-tender remaining due using selected method
    if (effectivePayments.length === 0) {
      const enterAmt = Math.round(Number(tenderAmount) * 100);
      const amtToPay = enterAmt > 0 ? enterAmt : remainingDueCents;
      if (amtToPay > 0 || grandTotalCents === 0) {
        effectivePayments.push({
          method: selectedMethod,
          amountCents: amtToPay,
          reference: reference.trim() || undefined,
        });
      }
    }

    const totalTendered = effectivePayments.reduce((s, p) => s + p.amountCents, 0);
    if (totalTendered < grandTotalCents) {
      setError(`Insufficient payment: ${money(totalTendered)} tendered vs ${money(grandTotalCents)} due.`);
      return;
    }

    // Enforce credit sales require a customer
    if (effectivePayments.some((p) => p.method === 'credit') && !customer?._id) {
      setError('Walk-in customers cannot purchase on credit. Please select a registered customer.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await onSubmitCheckout({
        payments: effectivePayments.map((p) => ({
          method: p.method,
          amountCents: p.amountCents,
          reference: p.reference,
        })),
        printReceipt,
        smsReceipt,
      });

      if (onSuccess) {
        onSuccess(result);
      }
    } catch (err) {
      setError(err.message || 'Checkout failed. Please check network and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="payment-modal-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="payment-modal-title">Complete Sale (F9)</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div className={styles.content}>
          {!isOnline && (
            <div className={styles.offlineNotice}>
              <Alert tone="warning">
                You&apos;re offline. Your cart is saved and will be sent when the connection returns.
              </Alert>
            </div>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          {/* Totals Summary */}
          <div className={styles.summaryBox}>
            <div className={styles.summaryItem}>
              <span>Grand Total</span>
              <strong>{money(grandTotalCents)}</strong>
            </div>
            <div className={styles.summaryItem}>
              <span>Tendered</span>
              <strong>{money(totalPaidCents)}</strong>
            </div>
            <div className={styles.summaryItem}>
              <span>Remaining Due</span>
              <strong className={styles.dueAmount}>{money(remainingDueCents)}</strong>
            </div>
            {changeDueCents > 0 && (
              <div className={styles.summaryItem}>
                <span>Change Due</span>
                <strong className={styles.changeAmount}>{money(changeDueCents)}</strong>
              </div>
            )}
          </div>

          {/* Payment Method Selector */}
          <div>
            <div className={styles.sectionTitle}>Select Payment Method</div>
            <div className={styles.methodGrid}>
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`${styles.methodTile} ${selectedMethod === m.id ? styles.methodActive : ''}`}
                  onClick={() => setSelectedMethod(m.id)}
                >
                  <span style={{ fontSize: '1.25rem' }}>{m.icon}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Tender Inputs & Quick Tender */}
          <div className={styles.tenderSection}>
            <div className={styles.tenderInputs}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>Tender Amount (LKR)</span>
                <input
                  type="number"
                  step="0.01"
                  placeholder={remainingDueCents > 0 ? (remainingDueCents / 100).toFixed(2) : '0.00'}
                  value={tenderAmount}
                  onChange={(e) => setTenderAmount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddPayment()}
                />
              </label>
              <Button type="button" variant="secondary" onClick={handleAddPayment}>
                + Add Tender
              </Button>
            </div>

            {selectedMethod === 'cash' && (
              <div className={styles.quickRow}>
                <button
                  type="button"
                  className={styles.quickBtn}
                  onClick={() => handleQuickCash(remainingDueCents)}
                >
                  Exact ({money(remainingDueCents)})
                </button>
                <button
                  type="button"
                  className={styles.quickBtn}
                  onClick={() => handleQuickCash(remainingDueCents + 50000)}
                >
                  + Rs 500
                </button>
                <button
                  type="button"
                  className={styles.quickBtn}
                  onClick={() => handleQuickCash(remainingDueCents + 100000)}
                >
                  + Rs 1,000
                </button>
                <button
                  type="button"
                  className={styles.quickBtn}
                  onClick={() => handleQuickCash(remainingDueCents + 500000)}
                >
                  + Rs 5,000
                </button>
              </div>
            )}

            {(selectedMethod === 'card' || selectedMethod === 'bank_transfer' || selectedMethod === 'cheque') && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>Reference / Tx ID / Cheque #</span>
                <input
                  type="text"
                  placeholder="Approval code or reference number"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            )}
          </div>

          {/* Tendered Payments List */}
          {payments.length > 0 && (
            <div>
              <div className={styles.sectionTitle}>Tendered Payments</div>
              <div className={styles.paymentsList}>
                {payments.map((p) => {
                  const methodObj = PAYMENT_METHODS.find((m) => m.id === p.method);
                  return (
                    <div key={p.id} className={styles.paymentRow}>
                      <div>
                        <strong>{methodObj?.icon} {methodObj?.label}</strong>
                        {p.reference && <small style={{ color: 'var(--label)', marginLeft: 8 }}>({p.reference})</small>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{money(p.amountCents)}</span>
                        <button
                          type="button"
                          className={styles.removePayBtn}
                          onClick={() => handleRemovePayment(p.id)}
                          aria-label="Remove payment line"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action Toggles */}
          <div className={styles.toggles}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={printReceipt}
                onChange={(e) => setPrintReceipt(e.target.checked)}
              />
              Print Receipt
            </label>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={smsReceipt}
                onChange={(e) => setSmsReceipt(e.target.checked)}
              />
              Send SMS Receipt
            </label>
          </div>
        </div>

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleCompleteSale}
            disabled={submitting}
          >
            {submitting ? 'Processing…' : `Complete Sale (${money(grandTotalCents)})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
