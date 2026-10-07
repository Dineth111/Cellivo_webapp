'use client';

import { money } from '../ui';
import styles from './ReceiptPrint.module.css';

/**
 * Format UTC date/time to local representation.
 */
function formatDateTime(d) {
  if (!d) return '-';
  const date = new Date(d);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function ReceiptPrint({ invoice, template = 'thermal-80', isReprint = false }) {
  if (!invoice) return null;

  const {
    invoiceNumber,
    createdAt,
    customerSnapshot,
    salespersonId,
    lines = [],
    payments = [],
    subtotalCents = 0,
    discountCents = 0,
    taxCents = 0,
    tradeInCents = 0,
    grandTotalCents = 0,
    totalPaidCents = 0,
    changeDueCents = 0,
    notes = '',
    branch = {},
    tenant = {},
  } = invoice;

  const shopName = tenant.name || 'Cellivo Electronics';
  const branchName = branch.name || 'Main Branch';
  const branchAddress = branch.address || 'Colombo, Sri Lanka';
  const branchPhone = branch.phone || '+94 11 234 5678';
  const taxNumber = tenant.billingDetails?.taxNumber || 'VAT-102938475';
  const cashierName = salespersonId?.name || 'Cashier';

  const containerClass =
    template === 'thermal-58'
      ? `${styles.printableContainer} ${styles.thermal58}`
      : template === 'thermal-80'
      ? `${styles.printableContainer} ${styles.thermal80}`
      : template === 'a5'
      ? `${styles.printableContainer} ${styles.a5}`
      : `${styles.printableContainer} ${styles.a4}`;

  const isThermal = template === 'thermal-58' || template === 'thermal-80';

  if (isThermal) {
    return (
      <div className={containerClass}>
        {/* REPRINT Badge */}
        {isReprint && (
          <div style={{ textAlign: 'center' }}>
            <span className={styles.reprintBadge}>*** REPRINT ***</span>
          </div>
        )}

        {/* Shop Header */}
        <div className={styles.shopHeader}>
          <div className={styles.logo}>CELLIVO</div>
          <div className={styles.shopName}>{shopName}</div>
          <div className={styles.shopMeta}>{branchName} - {branchAddress}</div>
          <div className={styles.shopMeta}>Tel: {branchPhone}</div>
          {taxNumber && <div className={styles.taxReg}>VAT Reg: {taxNumber}</div>}
        </div>

        <div className={styles.divider} />

        {/* Invoice Metadata */}
        <div>
          <div className={styles.metaRow}>
            <span>Inv #: <strong>{invoiceNumber}</strong></span>
            <span>Date: {formatDateTime(createdAt)}</span>
          </div>
          <div className={styles.metaRow}>
            <span>Cashier: {cashierName}</span>
            <span>Customer: {customerSnapshot?.name || 'Walk-in'}</span>
          </div>
          {customerSnapshot?.phone && (
            <div className={styles.metaRow}>
              <span>Phone: {customerSnapshot.phone}</span>
            </div>
          )}
        </div>

        <div className={styles.divider} />

        {/* Line Items Table */}
        <table className={styles.itemsTable}>
          <thead>
            <tr>
              <th>Item</th>
              <th className={styles.qtyCol}>Qty</th>
              <th className={styles.priceCol}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l._id || idx}>
                <td>
                  <div className={styles.itemName}>{l.name}</div>
                  {l.imei && <div className={styles.itemImei}>IMEI: {l.imei}</div>}
                  {l.imei ? (
                    <div className={styles.itemWarranty}>12 Months Warranty</div>
                  ) : (
                    <div className={styles.itemWarranty}>6 Months Warranty</div>
                  )}
                  {l.discountCents > 0 && (
                    <div className={styles.itemSub}>Disc: -{money(l.discountCents)}</div>
                  )}
                </td>
                <td className={styles.qtyCol}>{l.qty}</td>
                <td className={styles.priceCol}>{money(l.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className={styles.divider} />

        {/* Totals Section */}
        <div className={styles.totalsSection}>
          <div className={styles.totalRow}>
            <span>Subtotal:</span>
            <span>{money(subtotalCents)}</span>
          </div>
          {discountCents > 0 && (
            <div className={styles.totalRow}>
              <span>Discount:</span>
              <span>-{money(discountCents)}</span>
            </div>
          )}
          {taxCents > 0 && (
            <div className={styles.totalRow}>
              <span>Tax (VAT/SSCL):</span>
              <span>{money(taxCents)}</span>
            </div>
          )}
          {tradeInCents > 0 && (
            <div className={styles.totalRow}>
              <span>Trade-In Credit:</span>
              <span>-{money(tradeInCents)}</span>
            </div>
          )}
          <div className={styles.grandTotalRow}>
            <span>TOTAL:</span>
            <span>{money(grandTotalCents)}</span>
          </div>
        </div>

        {/* Payment Breakdown */}
        <div className={styles.paymentSection}>
          <div className={styles.paymentTitle}>Payment Summary</div>
          {payments.length === 0 ? (
            <div className={styles.paymentRow}>
              <span>Amount Paid:</span>
              <span>{money(totalPaidCents || grandTotalCents)}</span>
            </div>
          ) : (
            payments.map((p, idx) => (
              <div key={p._id || idx} className={styles.paymentRow}>
                <span>
                  {p.method.toUpperCase()}
                  {p.reference ? ` (${p.reference})` : ''}:
                </span>
                <span>{money(p.amountCents)}</span>
              </div>
            ))
          )}
          {changeDueCents > 0 && (
            <div className={styles.paymentRow} style={{ fontWeight: 700 }}>
              <span>Change Due:</span>
              <span>{money(changeDueCents)}</span>
            </div>
          )}
        </div>

        {notes && (
          <>
            <div className={styles.divider} />
            <div style={{ fontSize: 10, color: '#4b5563' }}>Note: {notes}</div>
          </>
        )}

        <div className={styles.divider} />

        {/* Warranty & Terms */}
        <div className={styles.warrantySection}>
          <h4>Warranty Policy & Terms</h4>
          <p>
            Hardware warranty covers manufacturer defects only. Physical damage, liquid damage,
            and display cracks void all warranties. Returns accepted within 7 days with original receipt.
          </p>
        </div>

        <div className={styles.thankYou}>Thank you for your purchase!</div>

        {/* Barcode / Scan Indicator */}
        <div className={styles.barcodeFooter}>
          <div className={styles.barcodeVisual}>*{invoiceNumber}*</div>
        </div>
      </div>
    );
  }

  // Formal A4 / A5 Layout
  return (
    <div className={containerClass}>
      {/* REPRINT Watermark */}
      {isReprint && (
        <div style={{ textAlign: 'center' }}>
          <span className={styles.reprintWatermarkA4}>*** REPRINT - COPY ***</span>
        </div>
      )}

      {/* Formal Header */}
      <div className={styles.formalHeader}>
        <div>
          <div className={styles.logo} style={{ fontSize: 26, color: '#1e3a8a' }}>CELLIVO</div>
          <h2 style={{ margin: 0, fontSize: 18, color: '#111827' }}>{shopName}</h2>
          <div style={{ color: '#4b5563', fontSize: 12 }}>{branchName}</div>
          <div style={{ color: '#4b5563', fontSize: 12 }}>{branchAddress}</div>
          <div style={{ color: '#4b5563', fontSize: 12 }}>Phone: {branchPhone}</div>
          {taxNumber && <div style={{ color: '#1e3a8a', fontWeight: 600, fontSize: 12 }}>VAT Reg: {taxNumber}</div>}
        </div>

        <div className={styles.formalTitleBlock}>
          <h1 className={styles.formalInvoiceTitle}>TAX INVOICE</h1>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <div>Invoice Number: <strong>{invoiceNumber}</strong></div>
            <div>Date & Time: {formatDateTime(createdAt)}</div>
            <div>Cashier: {cashierName}</div>
          </div>
        </div>
      </div>

      {/* Bill To & Details Cards */}
      <div className={styles.partyCards}>
        <div className={styles.partyCard}>
          <h4>Billed To (Customer)</h4>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{customerSnapshot?.name || 'Walk-in Customer'}</div>
          {customerSnapshot?.phone && <div>Phone: {customerSnapshot.phone}</div>}
          {customerSnapshot?.email && <div>Email: {customerSnapshot.email}</div>}
          {customerSnapshot?.address && <div>Address: {customerSnapshot.address}</div>}
        </div>

        <div className={styles.partyCard}>
          <h4>Invoice Summary</h4>
          <div>Status: <strong style={{ textTransform: 'uppercase', color: '#047857' }}>Completed</strong></div>
          <div>Payment Status: <strong style={{ textTransform: 'uppercase' }}>Paid</strong></div>
          {notes && <div>Reference / Notes: {notes}</div>}
        </div>
      </div>

      {/* Line Items Table */}
      <table className={styles.formalTable}>
        <thead>
          <tr>
            <th>#</th>
            <th>Item Description</th>
            <th>IMEI / Serial</th>
            <th>Warranty</th>
            <th className={styles.qtyCol}>Qty</th>
            <th className={styles.priceCol}>Unit Price</th>
            <th className={styles.priceCol}>Discount</th>
            <th className={styles.priceCol}>Line Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => (
            <tr key={l._id || idx}>
              <td>{idx + 1}</td>
              <td>
                <div style={{ fontWeight: 600 }}>{l.name}</div>
                {l.barcode && <small style={{ color: '#6b7280' }}>Barcode: {l.barcode}</small>}
              </td>
              <td>
                {l.imei ? (
                  <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e3a8a' }}>{l.imei}</span>
                ) : (
                  <span style={{ color: '#9ca3af' }}>N/A</span>
                )}
              </td>
              <td>{l.imei ? '12 Months Company' : '6 Months Standard'}</td>
              <td className={styles.qtyCol}>{l.qty}</td>
              <td className={styles.priceCol}>{money(l.unitPriceCents)}</td>
              <td className={styles.priceCol}>
                {l.discountCents > 0 ? `-${money(l.discountCents)}` : '-'}
              </td>
              <td className={styles.priceCol} style={{ fontWeight: 700 }}>
                {money(l.lineTotalCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals & Payments Block */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, marginBottom: 24 }}>
        {/* Payment History */}
        <div>
          <h4 style={{ fontSize: 13, textTransform: 'uppercase', color: '#475569', marginBottom: 8 }}>Payment Breakdown</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>Method</th>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>Reference</th>
                <th style={{ textAlign: 'right', padding: '4px 0' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p, idx) => (
                <tr key={p._id || idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 0', textTransform: 'uppercase', fontWeight: 600 }}>{p.method}</td>
                  <td style={{ padding: '6px 0', color: '#64748b' }}>{p.reference || '-'}</td>
                  <td style={{ padding: '6px 0', textAlign: 'right' }}>{money(p.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {changeDueCents > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: '#047857' }}>
              Change Due: {money(changeDueCents)}
            </div>
          )}
        </div>

        {/* Financial Summary Table */}
        <table className={styles.formalTotalsTable}>
          <tbody>
            <tr>
              <td>Subtotal</td>
              <td style={{ textAlign: 'right' }}>{money(subtotalCents)}</td>
            </tr>
            {discountCents > 0 && (
              <tr>
                <td>Invoice Discount</td>
                <td style={{ textAlign: 'right', color: '#dc2626' }}>-{money(discountCents)}</td>
              </tr>
            )}
            {taxCents > 0 && (
              <tr>
                <td>Taxes (VAT/SSCL)</td>
                <td style={{ textAlign: 'right' }}>{money(taxCents)}</td>
              </tr>
            )}
            {tradeInCents > 0 && (
              <tr>
                <td>Trade-in Credit</td>
                <td style={{ textAlign: 'right', color: '#047857' }}>-{money(tradeInCents)}</td>
              </tr>
            )}
            <tr className={styles.formalGrandTotal}>
              <td>GRAND TOTAL</td>
              <td style={{ textAlign: 'right' }}>{money(grandTotalCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Warranty Terms and Conditions */}
      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '12px 16px', fontSize: 11, color: '#334155' }}>
        <h4 style={{ margin: '0 0 6px 0', fontSize: 12, textTransform: 'uppercase', color: '#1e293b' }}>Terms & Conditions</h4>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
          <li>Goods sold are covered under respective warranty terms as stated above. Please retain this invoice for all warranty claims.</li>
          <li>Hardware warranty is limited to manufacturing defects only. Damage caused by power surges, physical shock, unauthorized modification, or water damage is void.</li>
          <li>Exchange is possible within 7 business days from the date of purchase with the original packaging and accessories.</li>
        </ul>
      </div>

      {/* Signatures & Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 40, paddingTop: 10, fontSize: 12 }}>
        <div style={{ textAlign: 'center', width: 180 }}>
          <div style={{ borderTop: '1px solid #94a3b8', paddingTop: 6 }}>Customer Signature</div>
        </div>
        <div style={{ textAlign: 'center', width: 180 }}>
          <div style={{ borderTop: '1px solid #94a3b8', paddingTop: 6 }}>Authorized Signature</div>
        </div>
      </div>
    </div>
  );
}
