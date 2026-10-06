'use client';

import { useState } from 'react';
import { Button, Field, Alert, Spinner, money } from '../ui';
import { recordCashMovement } from '../../lib/posApi';
import styles from './CashMovementModal.module.css';

export default function CashMovementModal({
  isOpen,
  onClose,
  session,
  onSuccess,
}) {
  const [type, setType] = useState('cash_in'); // 'cash_in' | 'cash_out'
  const [amountStr, setAmountStr] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const amtFloat = parseFloat(amountStr);
    if (isNaN(amtFloat) || amtFloat <= 0) {
      setError('Please enter a valid amount greater than 0.');
      return;
    }

    if (!reason.trim()) {
      setError('Please provide a reason for this cash movement.');
      return;
    }

    const amountCents = Math.round(amtFloat * 100);

    setLoading(true);
    try {
      const updated = await recordCashMovement({
        sessionId: session?._id,
        type,
        amountCents,
        reason: reason.trim(),
      });

      setAmountStr('');
      setReason('');
      onSuccess?.(updated);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to record cash movement.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="movement-modal-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="movement-modal-title">Record Cash Movement (Pay-In / Pay-Out)</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.body}>
            {error && <Alert tone="danger">{error}</Alert>}

            {session && (
              <div className={styles.currentBalance}>
                <span>Current Expected Cash:</span>
                <strong>{money(session.expectedCashCents || 0)}</strong>
              </div>
            )}

            <div className={styles.typeSelector}>
              <button
                type="button"
                className={`${styles.typeBtn} ${type === 'cash_in' ? styles.typeBtnActiveIn : ''}`}
                onClick={() => setType('cash_in')}
              >
                + Cash In (Pay-In)
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${type === 'cash_out' ? styles.typeBtnActiveOut : ''}`}
                onClick={() => setType('cash_out')}
              >
                - Cash Out (Pay-Out)
              </button>
            </div>

            <Field label="Amount (LKR)">
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="e.g. 500.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
                autoFocus
              />
            </Field>

            <Field label="Reason / Notes">
              <input
                type="text"
                placeholder={type === 'cash_in' ? 'e.g. Petty cash float top-up' : 'e.g. Office tea/coffee supplies'}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </Field>
          </div>

          <div className={styles.footer}>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={type === 'cash_in' ? 'primary' : 'danger'} disabled={loading}>
              {loading ? <Spinner /> : type === 'cash_in' ? 'Record Cash In' : 'Record Cash Out'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
