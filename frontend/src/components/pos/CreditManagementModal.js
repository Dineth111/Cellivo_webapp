'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Alert, money, Badge } from '../ui';
import {
  getOverdueInstallments,
  getCustomerAging,
  recordCreditPayment,
  sendInstallmentReminder,
} from '../../lib/posApi';
import styles from './CreditManagementModal.module.css';

export default function CreditManagementModal({
  isOpen,
  onClose,
  customers = [],
  onPaymentRecorded,
}) {
  const [activeTab, setActiveTab] = useState('overdue'); // 'overdue' | 'aging'
  const [overdueList, setOverdueList] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [agingData, setAgingData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // { tone, text }
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payReference, setPayReference] = useState('');
  const [submittingPayment, setSubmittingPayment] = useState(false);

  const effectiveCustomerId = selectedCustomerId || (customers.length > 0 ? customers[0]._id : '');

  // Load branch overdue installments
  const loadOverdue = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOverdueInstallments();
      setOverdueList(data || []);
    } catch {
      setOverdueList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load customer aging breakdown
  const loadCustomerAging = useCallback(async (custId) => {
    if (!custId) {
      setAgingData(null);
      return;
    }
    setLoading(true);
    try {
      const data = await getCustomerAging(custId);
      setAgingData(data);
    } catch {
      setAgingData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    if (isOpen) {
      getOverdueInstallments()
        .then((items) => {
          if (isMounted) setOverdueList(items || []);
        })
        .catch(() => {
          if (isMounted) setOverdueList([]);
        });

      if (effectiveCustomerId) {
        getCustomerAging(effectiveCustomerId)
          .then((data) => {
            if (isMounted) setAgingData(data);
          })
          .catch(() => {
            if (isMounted) setAgingData(null);
          });
      }
    }
    return () => {
      isMounted = false;
    };
  }, [isOpen, effectiveCustomerId]);

  const handleCustomerChange = (custId) => {
    setSelectedCustomerId(custId);
    setActionMsg(null);
    loadCustomerAging(custId);
  };

  const handleSendReminder = async (planId, installmentNo, customerPhone) => {
    setActionMsg(null);
    try {
      const res = await sendInstallmentReminder(planId, installmentNo);
      setActionMsg({
        tone: 'success',
        text: `Reminder SMS sent to ${res.sentTo || customerPhone} for ${money(res.amountCents)} due on ${res.dueDate}.`,
      });
    } catch (err) {
      setActionMsg({ tone: 'danger', text: err.message || 'Failed to dispatch reminder SMS.' });
    }
  };

  const handleRecordCollection = async (e) => {
    if (e) e.preventDefault();
    const amtCents = Math.round(Number(payAmount) * 100);
    if (isNaN(amtCents) || amtCents <= 0) {
      setActionMsg({ tone: 'danger', text: 'Please enter a valid payment amount.' });
      return;
    }

    if (!selectedCustomerId) {
      setActionMsg({ tone: 'danger', text: 'Please select a customer.' });
      return;
    }

    setSubmittingPayment(true);
    setActionMsg(null);
    try {
      const result = await recordCreditPayment({
        customerId: selectedCustomerId,
        amountCents: amtCents,
        paymentMethod: payMethod,
        reference: payReference.trim() || undefined,
      });

      setActionMsg({
        tone: 'success',
        text: `Collection of ${money(result.amountPaidCents)} recorded! Applied oldest-due first across active installments.`,
      });
      setPayAmount('');
      setPayReference('');

      // Refresh customer aging and overdue list
      loadCustomerAging(selectedCustomerId);
      loadOverdue();

      if (onPaymentRecorded) onPaymentRecorded(result);
    } catch (err) {
      setActionMsg({ tone: 'danger', text: err.message || 'Failed to record collection payment.' });
    } finally {
      setSubmittingPayment(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="credit-modal-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="credit-modal-title">Credit & Installments Management (F6)</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={styles.tabBtn + (activeTab === 'overdue' ? ' ' + styles.tabBtnActive : '')}
            onClick={() => setActiveTab('overdue')}
          >
            Overdue Tracking ({overdueList.length})
          </button>
          <button
            type="button"
            className={styles.tabBtn + (activeTab === 'aging' ? ' ' + styles.tabBtnActive : '')}
            onClick={() => setActiveTab('aging')}
          >
            Customer Aging & Collections
          </button>
        </div>

        <div className={styles.content}>
          {actionMsg && <Alert tone={actionMsg.tone}>{actionMsg.text}</Alert>}

          {/* TAB 1: Overdue Installments */}
          {activeTab === 'overdue' && (
            <>
              {loading ? (
                <div>Loading overdue installments…</div>
              ) : overdueList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--label)' }}>
                  ✅ No overdue installments at this branch.
                </div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Invoice / Plan</th>
                      <th>Inst #</th>
                      <th>Due Date</th>
                      <th>Overdue</th>
                      <th>Unpaid</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdueList.map((item, idx) => (
                      <tr key={item.planId + '-' + item.installmentNumber + '-' + idx}>
                        <td>
                          <strong>{item.customerName}</strong>
                          <div style={{ fontSize: '0.75rem', color: 'var(--label)' }}>{item.customerPhone}</div>
                        </td>
                        <td>{item.invoiceNumber}</td>
                        <td>#{item.installmentNumber}</td>
                        <td>{new Date(item.dueDate).toLocaleDateString()}</td>
                        <td>
                          <Badge tone="danger">{item.daysOverdue} days</Badge>
                        </td>
                        <td>
                          <strong>{money(item.unpaidCents)}</strong>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className={styles.actionBtn}
                              onClick={() => handleSendReminder(item.planId, item.installmentNumber, item.customerPhone)}
                              title="Send Reminder SMS"
                            >
                              📲 SMS
                            </button>
                            <button
                              type="button"
                              className={styles.actionBtn}
                              onClick={() => {
                                setSelectedCustomerId(item.customerId);
                                setActiveTab('aging');
                                loadCustomerAging(item.customerId);
                              }}
                            >
                              Collect
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* TAB 2: Customer Aging & Collection Payment */}
          {activeTab === 'aging' && (
            <>
              {/* Customer Selector */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>
                  Select Customer:
                </label>
                <select
                  value={selectedCustomerId}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  style={{ minHeight: 44, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 6, flex: 1, background: 'var(--surface)' }}
                >
                  <option value="">-- Choose a Customer --</option>
                  {customers.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name} ({c.phone || 'No phone'}) - Bal: {money(c.currentBalanceCents || 0)} / Limit: {money(c.creditLimitCents || 0)}
                    </option>
                  ))}
                </select>
              </div>

              {agingData && (
                <>
                  {/* Aging Summary Buckets */}
                  <div className={styles.agingGrid}>
                    <div className={styles.agingCard}>
                      <label>Current</label>
                      <strong style={{ color: 'var(--success)' }}>{money(agingData.buckets.current)}</strong>
                    </div>
                    <div className={styles.agingCard}>
                      <label>1 - 30 Days</label>
                      <strong style={{ color: '#d97706' }}>{money(agingData.buckets['1-30'])}</strong>
                    </div>
                    <div className={styles.agingCard}>
                      <label>31 - 60 Days</label>
                      <strong style={{ color: '#ea580c' }}>{money(agingData.buckets['31-60'])}</strong>
                    </div>
                    <div className={styles.agingCard}>
                      <label>61 - 90 Days</label>
                      <strong style={{ color: 'var(--danger)' }}>{money(agingData.buckets['61-90'])}</strong>
                    </div>
                    <div className={styles.agingCard}>
                      <label>90+ Days</label>
                      <strong style={{ color: 'var(--danger)' }}>{money(agingData.buckets['90+'])}</strong>
                    </div>
                    <div className={styles.agingCard}>
                      <label>Total Outstanding</label>
                      <strong style={{ color: 'var(--brand)' }}>{money(agingData.buckets.totalOutstandingCents)}</strong>
                    </div>
                  </div>

                  {/* Receive Payment / Collection Form */}
                  <form onSubmit={handleRecordCollection} className={styles.payBox}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--heading)' }}>
                      Record Collection Payment (Oldest-Due First)
                    </span>
                    <div className={styles.payInputs}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>Amount (LKR)</span>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="e.g. 500.00"
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--label)', fontWeight: 600 }}>Payment Method</span>
                        <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                          <option value="cash">Cash</option>
                          <option value="card">Card</option>
                          <option value="bank_transfer">Bank Transfer</option>
                          <option value="cheque">Cheque</option>
                        </select>
                      </label>
                      <Button type="submit" disabled={submittingPayment || !payAmount}>
                        {submittingPayment ? 'Saving…' : 'Record Payment'}
                      </Button>
                    </div>
                  </form>

                  {/* Overdue Items List for Customer */}
                  {agingData.overdueInstallments?.length > 0 && (
                    <div>
                      <h3 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '8px 0', color: 'var(--heading)' }}>
                        Overdue Installments ({agingData.overdueInstallments.length})
                      </h3>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Inst #</th>
                            <th>Due Date</th>
                            <th>Overdue</th>
                            <th>Unpaid</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {agingData.overdueInstallments.map((inst, idx) => (
                            <tr key={inst.planId + '-' + inst.installmentNumber + '-' + idx}>
                              <td>{inst.invoiceNumber}</td>
                              <td>#{inst.installmentNumber}</td>
                              <td>{new Date(inst.dueDate).toLocaleDateString()}</td>
                              <td>
                                <Badge tone="danger">{inst.daysOverdue} days</Badge>
                              </td>
                              <td>
                                <strong>{money(inst.unpaidCents)}</strong>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className={styles.actionBtn}
                                  onClick={() => handleSendReminder(inst.planId, inst.installmentNumber, agingData.customer.phone)}
                                >
                                  📲 Send SMS
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
