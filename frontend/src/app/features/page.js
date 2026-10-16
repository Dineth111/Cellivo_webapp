import SiteShell from '../../components/site/SiteShell';
import { CtaBand } from '../../components/site/HomePage';
import styles from '../../components/site/site.module.css';

export const metadata = { title: 'Features | Cellivo', description: 'POS billing, IMEI tracking, repairs, finance, reports and more for phone shops.' };

const GROUPS = [
  ['POS Billing', [
    ['Fast Billing', 'Create clean invoices in seconds with quick item lookup and automatic totals.'],
    ['Multi-Payment Support', 'Cash, card, bank transfer and split payments.'],
    ['Repair Billing', 'Bill labor, parts and warranty work together.'],
    ['Exchange / Trade-In', 'Handle trade-ins with automatic value adjustments.'],
    ['Discount Approval', 'Discount limits by role with manager override.'],
    ['Wholesale', 'Wholesale price tiers and bulk invoicing.'],
    ['Customer Lookup', 'History, credit balance and loyalty points at checkout.'],
    ['Invoice Printing', 'Thermal receipts, A4 invoices or emailed copies.'],
  ]],
  ['IMEI & Inventory', [
    ['Purchase & GRN', 'Purchase orders and goods-received matching.'],
    ['IMEI Tracking', 'Track each phone from purchase to sale, return or warranty.'],
    ['Serial Number Tracking', 'Serialized accessories and parts alongside IMEI stock.'],
    ['Barcode Management', 'Generate, print and scan barcodes.'],
    ['Stock Alerts', 'Low-stock alerts before best sellers run out.'],
    ['Stock Transfer', 'Move stock between branches with approval.'],
    ['Supplier Management', 'Supplier profiles, history and performance.'],
    ['Supplier Payment', 'Balances, scheduled payments and reconciliation.'],
  ]],
  ['Repair Management', [
    ['Job Ticket Tracking', 'Customer, device issue, photos and promised date in one ticket.'],
    ['Technician Assignment', 'Assign jobs by skill and workload.'],
    ['Repair Workflow', 'Clear stages from intake to pickup.'],
    ['Repair Invoice', 'Auto invoice with parts and labor breakdown.'],
    ['Customer Status Page', 'A link where customers check their repair status.'],
    ['Parts Usage Tracking', 'Spare parts deducted from stock automatically.'],
    ['Warranty Tracking', 'Warranty periods with expiry alerts.'],
    ['Repair Notifications', 'SMS or email on every status change.'],
  ]],
  ['Finance & Customers', [
    ['Cash Drawer', 'Open and close sessions, track every cash movement.'],
    ['Bank & Cheques', 'Bank balances, cheque maturity and status.'],
    ['Ledgers & Expenses', 'Customer/supplier ledgers and categorized expenses.'],
    ['Installments & Credit', 'Payment plans, credit ledger and due tracking.'],
    ['Loyalty Points', 'Award on purchases, redeem at checkout.'],
    ['SMS Reminders', 'Automatic payment reminders.'],
  ]],
  ['Staff, Branches & Reports', [
    ['Role-Based Access', 'Granular permissions for cashiers, technicians and managers.'],
    ['Commission & Payroll', 'Commissions, advances and payslips.'],
    ['Multi-Branch', 'Branch stock, staff and reports from one admin view.'],
    ['Sales & Profit Reports', 'By product, category, staff and branch.'],
    ['Stock & Repair Reports', 'Valuation, ageing, turnaround and productivity.'],
    ['Finance Reports', 'P&L, cash flow and expense trends.'],
  ]],
  ['Integrations & Security', [
    ['WooCommerce Sync', 'Sync products, stock and orders with your online store.'],
    ['SMS & Email', 'Automated invoices, repair updates and reminders.'],
    ['Printers & Scanners', 'Thermal/A4 printers, USB and Bluetooth scanners.'],
    ['Two-Factor & IP Lock', 'Extra login security and IP restrictions.'],
    ['Audit Logs', 'Who did what, when and from where.'],
    ['Backup & Encryption', 'Daily backups; data encrypted in transit and at rest.'],
  ]],
];

export default function FeaturesPage() {
  return (
    <SiteShell active="/features">
      <section className={styles.hero}>
        <div className={styles.wrap}>
          <span className={styles.badge}>Features</span>
          <h1>Mobile Shop POS Features for Phone Shops</h1>
          <p>Billing, IMEI stock, repairs, finance and reports, built together for mobile retail.</p>
        </div>
      </section>
      {GROUPS.map(([title, items], i) => (
        <section key={title} className={`${styles.section} ${i % 2 ? styles.alt : ''}`}>
          <div className={styles.wrap}>
            <h2 className={styles.h2} style={{ marginBottom: 24 }}>{title}</h2>
            <div className={styles.grid}>
              {items.map(([t, d]) => <article key={t} className={styles.card}><h3>{t}</h3><p>{d}</p></article>)}
            </div>
          </div>
        </section>
      ))}
      <CtaBand />
    </SiteShell>
  );
}
