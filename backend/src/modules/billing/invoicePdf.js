/**
 * One-page PDF tax invoice, no dependency (FRS F-02: every payment has a downloadable PDF).
 * Plain text layout with the built-in Helvetica font. Swap for a template engine when branding is final.
 */
const money = (minorUnits, cur) => `${cur} ${(minorUnits / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

export function invoicePdf(inv) {
  const rows = [
    ['Cellivo - Tax invoice', 20, true],
    ['W3Inventor (Pvt) Ltd, Sri Lanka', 10],
    ['', 10],
    [`Invoice ${inv.number}`, 14, true],
    [`Date: ${date(inv.paidAt)}   Status: ${inv.status.toUpperCase()}`, 10],
    ['', 10],
    ['Bill to', 11, true],
    [inv.billTo?.name || '-', 10],
    ...(inv.billTo?.address ? [[inv.billTo.address, 10]] : []),
    ...(inv.billTo?.taxNumber ? [[`Tax no: ${inv.billTo.taxNumber}`, 10]] : []),
    ['', 10],
    [`Plan: ${inv.planCode.toUpperCase()}   Billing term: ${inv.term}`, 10],
    [`Period: ${date(inv.periodStart)} to ${inv.term === 'lifetime' ? 'lifetime' : date(inv.periodEnd)}`, 10],
    ['', 10],
    [`Price: ${money(inv.price, inv.currency)}`, 10],
    ...(inv.discount ? [[`Discount${inv.couponCode ? ` (${inv.couponCode})` : ''}: -${money(inv.discount, inv.currency)}`, 10]] : []),
    ...(inv.credit ? [[`Credit for unused time on previous plan: -${money(inv.credit, inv.currency)}`, 10]] : []),
    ...(inv.tax ? [[`Tax: ${money(inv.tax, inv.currency)}`, 10]] : []),
    [`Total paid: ${money(inv.total, inv.currency)}`, 13, true],
    [`Payment method: ${inv.method === 'bank_transfer' ? 'Bank transfer' : 'Card'}${inv.reference ? `   Reference: ${inv.reference}` : ''}`, 9],
    ...(inv.refunds?.length ? [[`Refunded: ${money(inv.refunds.reduce((s, r) => s + r.amount, 0), inv.currency)}`, 10]] : []),
  ];

  let y = 790;
  const text = rows.map(([t, size, bold]) => { y -= size + 6; return `BT /${bold ? 'F2' : 'F1'} ${size} Tf 50 ${y} Td (${esc(t)}) Tj ET`; }).join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
