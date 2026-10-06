'use client';

import { useState, useMemo } from 'react';
import { Button, Alert, money, Badge } from '../ui';
import styles from './PaymentModal.module.css';

const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'card', label: 'Card', icon: '💳' },
  { id: 'bank_transfer', label: 'Bank Transfer', icon: '🏦' },
  { id: 'cheque', label: 'Cheque', icon: '📝' },
  { id: 'credit', label: 'Credit / Installment', icon: '📋' },
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

  // Installment plan & credit management state
  const [isInstallment, setIsInstallment] = useState(false);
  const [downPayment, setDownPayment] = useState('0');
  const [installmentCount, setInstallmentCount] = useState(3);
  const [frequency, setFrequency] = useState('monthly');
  const [firstDueDate, setFirstDueDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [managerPin, setManagerPin] = useState('');
  const [showPinPrompt, setShowPinPrompt] = useState(false);

  const grandTotalCents = totals?.grandTotalCents || 0;

  // Total paid across split payments
  const totalPaidCents = useMemo(() => {
    return payments.reduce((sum, p) => sum + p.amountCents, 0);
  }, [payments]);

  // Remaining due to cover invoice
  const remainingDueCents = Math.max(0, grandTotalCents - totalPaidCents);

  // Change due (only applies if total paid exceeds total, e.g. for cash)
  const changeDueCents = Math.max(0, totalPaidCents - grandTotalCents);

  // Financed amount calculation for installment preview
  const downPaymentCents = Math.round(Number(downPayment) * 100) || 0;
  const financedCents = Math.max(0, grandTotalCents - downPaymentCents);
  const perInstallmentEstCents = installmentCount > 0 ? Math.floor(financedCents / installmentCount) : 0;

  const handleAddPayment = () => {
    setError('');

    if (selectedMethod === 'loyalty_points') {
      if (!customer?._id) {
        setError('Loyalty points can only be redeemed for registered customers.');
        return;
      }
      const availablePoints = customer?.loyaltyPoints || 0;
      if (availablePoints < 100) {
        setError(`Minimum 100 points required to redeem. Customer has ${availablePoints} points.`);
        return;
      }
      const requestedPts = Math.round(Number(tenderAmount));
      if (isNaN(requestedPts) || requestedPts <= 0) {
        setError('Please enter points to redeem (e.g. 100).');
        return;
      }
      if (requestedPts < 100) {
        setError(`Minimum 100 points required to redeem.`);
        return;
      }
      if (requestedPts > availablePoints) {
        setError(`Insufficient points: Customer only has ${availablePoints} points.`);
        return;
      }
      const amtCents = requestedPts * 100; // 1 point = 100 cents (1 LKR)
      setPayments((prev) => [
        ...prev,
        {
          id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          method: 'loyalty_points',
          amountCents: amtCents,
          reference: String(requestedPts),
        },
      ]);
      setTenderAmount('');
      setReference('');
      return;
    }

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

    // If no payments explicitly added to the list:
    if (effectivePayments.length === 0) {
      if (selectedMethod === 'credit' && isInstallment) {
        // Down payment is recorded if > 0
        if (downPaymentCents > 0) {
          effectivePayments.push({
            method: 'cash',
            amountCents: downPaymentCents,
            reference: 'Installment Down Payment',
          });
        }
      } else {
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
    }

    const totalTendered = effectivePayments.reduce((s, p) => s + p.amountCents, 0);
    if (!isInstallment && !effectivePayments.some((p) => p.method === 'credit') && totalTendered < grandTotalCents) {
      setError(`Insufficient payment: ${money(totalTendered)} tendered vs ${money(grandTotalCents)} due.`);
      return;
    }

    // Enforce credit sales & installments require a customer
    if ((isInstallment || effectivePayments.some((p) => p.method === 'credit')) && !customer?._id) {
      setError('Walk-in customers cannot purchase on credit or installments. Please select a registered customer.');
      return;
    }

    setSubmitting(true);
    try {
      const installmentPlanData = isInstallment
        ? {
            downPaymentCents,
            numberOfInstallments: Number(installmentCount) || 3,
            frequency,
            firstDueDate,
          }
        : undefined;

      const result = await onSubmitCheckout({
        payments: effectivePayments.map((p) => ({
          method: p.method,
          amountCents: p.amountCents,
          reference: p.reference,
        })),
        installmentPlan: installmentPlanData,
        managerPin: managerPin.trim() || undefined,
        printReceipt,
        smsReceipt,
      });

      if (onSuccess) {
        onSuccess(result, { printReceipt, smsReceipt });
      }
    } catch (err) {
      const errMsg = err.message || 'Checkout failed. Please check network and try again.';
      setError(errMsg);
      if (errMsg.includes('credit limit') || errMsg.includes('V-07')) {
        setShowPinPrompt(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

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
                  className={styles.methodTile + (selectedMethod === m.id ? ' ' + styles.methodActive : '')}
                  onClick={() => {
                    setSelectedMethod(m.id);
                    if (m.id === 'credit') {
                      setIsInstallment(true);
                    }
                  }}
                >
                  <span style={{ fontSize: '1.25rem' }}>{m.icon}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Credit & Installment Configuration */}
          {selectedMethod === 'credit' && (
            <div style={{ background: 'var(--bg)', padding: 14, borderRadius: 8, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--heading)' }}>
                  Installment Purchase (F-11)
                </span>
                {customer?.creditLimitCents != null && (
                  <Badge tone="brand">
                    Limit: {money(customer.creditLimitCents)} (Bal: {money(customer.currentBalanceCents || 0)})
                  </Badge>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>Down Payment (LKR)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={downPayment}
                    onChange={(e) => setDownPayment(e.target.value)}
                    style={{ minHeight: 44, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>Installments (1-36)</span>
                  <input
                    type="number"
                    min="1"
                    max="36"
                    value={installmentCount}
                    onChange={(e) => setInstallmentCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    style={{ minHeight: 44, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                  />
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>Frequency</span>
                  <select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                    style={{ minHeight: 44, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}
                  >
                    <option value="monthly">Monthly</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>First Due Date</span>
                  <input
                    type="date"
                    value={firstDueDate}
                    onChange={(e) => setFirstDueDate(e.target.value)}
                    style={{ minHeight: 44, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                  />
                </label>
              </div>

              <div style={{ fontSize: '0.85rem', color: 'var(--body)', padding: '6px 10px', background: 'var(--surface)', borderRadius: 6 }}>
                Financed: <strong>{money(financedCents)}</strong> ({installmentCount}x ~{money(perInstallmentEstCents)} {frequency})
              </div>
            </div>
          )}

          {/* Manager Approval PIN (V-07 / Over Limit) */}
          {(showPinPrompt || selectedMethod === 'credit') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>
                  Manager Approval PIN (Required if exceeding credit limit)
                </span>
                <input
                  type="password"
                  placeholder="Enter manager PIN to override limit"
                  value={managerPin}
                  onChange={(e) => setManagerPin(e.target.value)}
                  style={{ minHeight: 44, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 6, maxWidth: 300 }}
                />
              </label>
            </div>
          )}

          {/* Loyalty Points Info & Tender Inputs */}
          {selectedMethod === 'loyalty_points' && (
            <div style={{ background: 'var(--bg)', padding: 14, borderRadius: 8, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--heading)' }}>Loyalty Points Redemption (CRM-06)</span>
                <Badge tone={(customer?.loyaltyPoints || 0) >= 100 ? 'success' : 'neutral'}>
                  Balance: {customer?.loyaltyPoints || 0} pts
                </Badge>
              </div>
              {(customer?.loyaltyPoints || 0) < 100 ? (
                <div style={{ fontSize: '0.82rem', color: 'var(--danger)' }}>
                  ⚠️ Minimum 100 points required to redeem. (1 point = Rs. 1.00)
                </div>
              ) : (
                <div style={{ fontSize: '0.82rem', color: 'var(--body)' }}>
                  💡 Conversion: 1 Point = Rs. 1.00 (100 cents). Enter whole points to redeem.
                </div>
              )}
            </div>
          )}

          {/* Tender Inputs & Quick Tender */}
          {selectedMethod !== 'credit' && (
            <div className={styles.tenderSection}>
              <div className={styles.tenderInputs}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>
                    {selectedMethod === 'loyalty_points' ? 'Points to Redeem (e.g. 100)' : 'Tender Amount (LKR)'}
                  </span>
                  <input
                    type="number"
                    step={selectedMethod === 'loyalty_points' ? '1' : '0.01'}
                    placeholder={
                      selectedMethod === 'loyalty_points'
                        ? Math.min(customer?.loyaltyPoints || 0, Math.ceil(remainingDueCents / 100)).toString()
                        : remainingDueCents > 0
                        ? (remainingDueCents / 100).toFixed(2)
                        : '0.00'
                    }
                    value={tenderAmount}
                    onChange={(e) => setTenderAmount(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddPayment()}
                  />
                </label>
                <Button type="button" variant="secondary" onClick={handleAddPayment}>
                  {selectedMethod === 'loyalty_points' ? '+ Apply Points' : '+ Add Tender'}
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
          )}

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
