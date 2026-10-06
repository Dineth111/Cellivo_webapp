'use client';

import { useState, useMemo } from 'react';
import { Button, Alert, money, Badge } from '../ui';
import { lookupReturnInvoice, processReturn, processExchange } from '../../lib/posApi';
import styles from './ReturnModal.module.css';

const REFUND_METHODS = [
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'card', label: 'Card', icon: '💳' },
  { id: 'store_credit', label: 'Store Credit', icon: '📋' },
];

export default function ReturnModal({
  isOpen,
  onClose,
  onSuccess,
  currentCartLines = [],
  currentCustomer = null,
}) {
  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [invoiceData, setInvoiceData] = useState(null);
  const [selectedItems, setSelectedItems] = useState({});
  const [refundMethod, setRefundMethod] = useState('cash');
  const [isExchangeMode, setIsExchangeMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successResult, setSuccessResult] = useState(null);

  const handleLookup = async (e) => {
    if (e) e.preventDefault();
    if (!invoiceQuery.trim()) return;

    setError('');
    setLoading(true);
    setInvoiceData(null);
    setSelectedItems({});
    setSuccessResult(null);

    try {
      const data = await lookupReturnInvoice(invoiceQuery.trim());
      setInvoiceData(data);
    } catch (err) {
      setError(err.message || 'Invoice not found or unable to look up.');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleItem = (item) => {
    setSelectedItems((prev) => {
      const copy = { ...prev };
      if (copy[item.lineId]) {
        delete copy[item.lineId];
      } else {
        copy[item.lineId] = {
          lineId: item.lineId,
          productId: item.productId,
          name: item.name,
          barcode: item.barcode,
          imei: item.imei,
          qty: 1,
          condition: 'Resellable',
          reason: 'Customer return',
          unitPriceCents: item.netUnitPriceCents,
          refundCents: item.netUnitPriceCents,
        };
      }
      return copy;
    });
  };

  const handleItemQtyChange = (lineId, maxQty, newQty) => {
    const qty = Math.min(Math.max(1, parseInt(newQty, 10) || 1), maxQty);
    setSelectedItems((prev) => {
      const item = prev[lineId];
      if (!item) return prev;
      return {
        ...prev,
        [lineId]: {
          ...item,
          qty,
          refundCents: item.unitPriceCents * qty,
        },
      };
    });
  };

  const handleItemConditionChange = (lineId, condition) => {
    setSelectedItems((prev) => {
      const item = prev[lineId];
      if (!item) return prev;
      return {
        ...prev,
        [lineId]: { ...item, condition },
      };
    });
  };

  const handleItemReasonChange = (lineId, reason) => {
    setSelectedItems((prev) => {
      const item = prev[lineId];
      if (!item) return prev;
      return {
        ...prev,
        [lineId]: { ...item, reason },
      };
    });
  };

  const totalRefundCents = useMemo(() => {
    return Object.values(selectedItems).reduce((sum, item) => sum + item.refundCents, 0);
  }, [selectedItems]);

  const handleSubmit = async () => {
    const itemsToReturn = Object.values(selectedItems);
    if (itemsToReturn.length === 0) {
      setError('Please select at least one item to return.');
      return;
    }

    setError('');
    setSubmitting(true);

    try {
      if (isExchangeMode && currentCartLines.length > 0) {
        // Exchange with current active cart
        const exchangePayload = {
          returnPayload: {
            invoiceId: invoiceData.invoiceId,
            items: itemsToReturn.map((it) => ({
              lineId: it.lineId,
              productId: it.productId,
              name: it.name,
              barcode: it.barcode,
              imei: it.imei,
              qty: it.qty,
              refundCents: it.refundCents,
              condition: it.condition,
              reason: it.reason,
            })),
          },
          salePayload: {
            customerId: currentCustomer?._id || invoiceData.customerId || undefined,
            lines: currentCartLines.map((l) => ({
              productId: l.productId,
              name: l.name,
              barcode: l.barcode,
              imei: l.imei || undefined,
              qty: l.qty,
              unitPriceCents: l.unitPriceCents,
            })),
            payments: [], // balance handled in exchange
          },
        };

        const res = await processExchange(exchangePayload);
        setSuccessResult({
          type: 'exchange',
          creditNoteNumber: res.creditNote.creditNoteNumber,
          exchangeInvoiceNumber: res.exchangeInvoice.invoiceNumber,
          totalRefundCents: res.exchangeCreditCents,
        });
        if (onSuccess) onSuccess(res);
      } else {
        // Regular return
        const returnPayload = {
          invoiceId: invoiceData.invoiceId,
          items: itemsToReturn.map((it) => ({
            lineId: it.lineId,
            productId: it.productId,
            name: it.name,
            barcode: it.barcode,
            imei: it.imei,
            qty: it.qty,
            refundCents: it.refundCents,
            condition: it.condition,
            reason: it.reason,
          })),
          refundMethod,
        };

        const res = await processReturn(returnPayload);
        setSuccessResult({
          type: 'return',
          creditNoteNumber: res.creditNoteNumber,
          totalRefundCents: res.totalRefundCents,
        });
        if (onSuccess) onSuccess(res);
      }
    } catch (err) {
      setError(err.message || 'Failed to process return. Please check supervisor authorization.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="return-modal-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="return-modal-title">Counter Returns & Exchanges (F4)</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div className={styles.content}>
          {error && <Alert tone="danger">{error}</Alert>}

          {successResult ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Alert tone="success">
                {successResult.type === 'exchange'
                  ? `Counter Exchange completed! Credit Note #${successResult.creditNoteNumber} issued and applied to Invoice #${successResult.exchangeInvoiceNumber}.`
                  : `Return successfully processed! Credit Note #${successResult.creditNoteNumber} issued for ${money(successResult.totalRefundCents)}.`}
              </Alert>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <Button type="button" onClick={onClose}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Invoice Lookup Field */}
              <form onSubmit={handleLookup} className={styles.lookupBar}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label htmlFor="inv-lookup-input" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)' }}>
                    Original Invoice Number
                  </label>
                  <input
                    id="inv-lookup-input"
                    type="text"
                    className={styles.lookupInput}
                    placeholder="e.g. INV-2026-0001"
                    value={invoiceQuery}
                    onChange={(e) => setInvoiceQuery(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={loading || !invoiceQuery.trim()}>
                  {loading ? 'Searching...' : 'Lookup'}
                </Button>
              </form>

              {/* Invoice Header Details */}
              {invoiceData && (
                <>
                  <div className={styles.invoiceInfo}>
                    <div>
                      <span>Invoice: </span>
                      <strong>{invoiceData.invoiceNumber}</strong>
                    </div>
                    <div>
                      <span>Customer: </span>
                      <strong>{invoiceData.customerSnapshot?.name || 'Walk-in'}</strong>
                    </div>
                    <div>
                      <span>Date: </span>
                      <strong>{new Date(invoiceData.createdAt).toLocaleDateString()}</strong>
                    </div>
                    <div>
                      <span>Status: </span>
                      <Badge tone={invoiceData.status === 'completed' ? 'success' : 'warning'}>
                        {invoiceData.status}
                      </Badge>
                    </div>
                  </div>

                  {!invoiceData.isWithinWindow && (
                    <Alert tone="warning">
                      Purchase was {invoiceData.daysSincePurchase} days ago. Return window ({invoiceData.returnWindowDays} days) has expired. Manager approval required.
                    </Alert>
                  )}

                  {/* Eligible Items Table */}
                  <div>
                    <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '8px 0', color: 'var(--heading)' }}>
                      Eligible Items for Return
                    </h3>
                    <table className={styles.itemsTable}>
                      <thead>
                        <tr>
                          <th style={{ width: 44 }}>Select</th>
                          <th>Product</th>
                          <th>Sold / Rem</th>
                          <th>Return Qty</th>
                          <th>Condition</th>
                          <th>Refund</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoiceData.eligibleItems.map((item) => {
                          const isSelected = !!selectedItems[item.lineId];
                          const selected = selectedItems[item.lineId];
                          const isEligible = item.eligibleQty > 0;

                          return (
                            <tr key={item.lineId} className={isSelected ? styles.itemRowActive : ''}>
                              <td style={{ textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  disabled={!isEligible}
                                  checked={isSelected}
                                  onChange={() => handleToggleItem(item)}
                                  style={{ width: 20, height: 20, cursor: isEligible ? 'pointer' : 'not-allowed' }}
                                  aria-label={`Select ${item.name}`}
                                />
                              </td>
                              <td>
                                <div style={{ fontWeight: 600, color: 'var(--heading)' }}>{item.name}</div>
                                {item.imei && <div style={{ fontSize: '0.75rem', color: 'var(--label)' }}>IMEI: {item.imei}</div>}
                                {item.barcode && !item.imei && (
                                  <div style={{ fontSize: '0.75rem', color: 'var(--label)' }}>Barcode: {item.barcode}</div>
                                )}
                              </td>
                              <td>
                                {item.soldQty} sold / <strong>{item.eligibleQty}</strong> rem
                              </td>
                              <td>
                                {isSelected ? (
                                  <input
                                    type="number"
                                    min="1"
                                    max={item.eligibleQty}
                                    value={selected.qty}
                                    onChange={(e) => handleItemQtyChange(item.lineId, item.eligibleQty, e.target.value)}
                                    className={styles.qtyInput}
                                    disabled={item.imei != null} // IMEI devices are always single unit
                                  />
                                ) : (
                                  '-'
                                )}
                              </td>
                              <td>
                                {isSelected ? (
                                  <select
                                    value={selected.condition}
                                    onChange={(e) => handleItemConditionChange(item.lineId, e.target.value)}
                                    className={styles.conditionSelect}
                                  >
                                    <option value="Resellable">Resellable (Restock)</option>
                                    <option value="Damaged">Damaged (No Restock)</option>
                                    <option value="To supplier">To Supplier</option>
                                  </select>
                                ) : (
                                  '-'
                                )}
                              </td>
                              <td>
                                <strong>{money(isSelected ? selected.refundCents : item.netUnitPriceCents)}</strong>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mode & Method Selection */}
                  {totalRefundCents > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {currentCartLines.length > 0 && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44 }}>
                          <input
                            type="checkbox"
                            checked={isExchangeMode}
                            onChange={(e) => setIsExchangeMode(e.target.checked)}
                            style={{ width: 18, height: 18 }}
                          />
                          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--heading)' }}>
                            Exchange directly with current active cart ({currentCartLines.length} items)
                          </span>
                        </label>
                      )}

                      {!isExchangeMode && (
                        <div>
                          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--heading)', marginBottom: 8 }}>
                            Refund Method
                          </div>
                          <div className={styles.methodGrid}>
                            {REFUND_METHODS.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className={styles.methodTile + (refundMethod === m.id ? ' ' + styles.methodActive : '')}
                                onClick={() => setRefundMethod(m.id)}
                              >
                                <span style={{ fontSize: '1.25rem' }}>{m.icon}</span>
                                <span>{m.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Refund Total Summary */}
                      <div className={styles.summaryBox}>
                        <span>{isExchangeMode ? 'Exchange Credit' : 'Total Refund Amount'}</span>
                        <strong>{money(totalRefundCents)}</strong>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {!successResult && (
          <div className={styles.footer}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={submitting || totalRefundCents === 0}
              onClick={handleSubmit}
            >
              {submitting
                ? 'Processing...'
                : isExchangeMode
                ? 'Process Counter Exchange'
                : `Refund ${money(totalRefundCents)}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
