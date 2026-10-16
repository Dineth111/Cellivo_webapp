import Link from 'next/link';
import SiteShell from './SiteShell';
import styles from './site.module.css';

const PROBLEMS = [
  ['📱', 'IMEI tracking is manual', 'Spreadsheets lose phones. Track every device from purchase to sale, return or warranty.'],
  ['⏱️', 'Billing is slow', 'Generic POS tools make customers wait. Invoice in seconds with quick item lookup.'],
  ['🔧', 'Repairs get lost', 'Job tickets on paper go missing. Keep every repair, part and promise date in one place.'],
  ['📦', 'Stock is a guess', 'See exactly what is on the shelf, in every branch, before your best seller runs out.'],
];
const FEATURES = [
  ['POS Billing', 'Fast invoices, split payments, trade-ins and discount approval.'],
  ['IMEI Tracking', 'Every phone tracked by IMEI from purchase to sale.'],
  ['Repair Management', 'Job tickets, technicians, parts, warranty and status updates.'],
  ['Inventory & Barcodes', 'Stock alerts, GRN, transfers and barcode labels.'],
  ['Customers & Credit', 'Customer history, credit ledger, installments and loyalty points.'],
  ['Finance', 'Cash drawer, bank accounts, cheques, expenses and ledgers.'],
  ['Reports', 'Sales, profit, stock and repair reports with export.'],
  ['Staff & Roles', 'Role-based access, commission and payroll.'],
  ['Multi-Branch', 'Manage every shop and move stock between branches.'],
  ['SMS & Email', 'Automatic invoice, repair and payment reminders.'],
];
const WHY = [
  ['Save hours every week', 'Billing, stock and repairs in one system.'],
  ['Make fewer mistakes', 'IMEI checks and stock rules stop costly errors.'],
  ['Control your sales', 'See sales, profit and staff activity live.'],
  ['Look more professional', 'Clean receipts and repair status links for customers.'],
];
const REVIEWS = [
  ['Saved 10 hrs/week', '“Billing and stock used to take half my day. Now it takes minutes.”', 'Shop owner', 'Phone shop, Colombo'],
  ['Zero lost phones', '“IMEI tracking ended our missing-stock problem completely.”', 'Manager', 'Mobile retailer, Kandy'],
  ['Repairs on time', '“Customers check their repair status online, so fewer calls.”', 'Technician lead', 'Repair centre, Galle'],
];
const FAQ = [
  ['Do I need a credit card to start?', 'No. Start the free trial with no card and add one only when you choose a plan.'],
  ['How fast can I get started?', 'Sign up and your system is ready in minutes. No installation or onboarding call.'],
  ['Does it track IMEI numbers?', 'Yes. Every phone is tracked by IMEI from purchase to sale, return or warranty claim.'],
  ['Can it manage repairs?', 'Yes. Job tickets, technicians, parts, invoices, warranty and customer status links.'],
  ['Can I cancel anytime?', 'Yes. There is no commitment; cancel from the billing page whenever you like.'],
  ['Which devices does it work on?', 'Any device with a browser: desktop, tablet or phone.'],
  ['Does it support multiple branches?', 'Yes. Growth, Business and Unlimited plans cover several branches.'],
];

export default function HomePage() {
  return (
    <SiteShell active="/">
      <section className={styles.hero}>
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div>
            <span className={styles.badge}>Trusted by 500+ phone shops</span>
            <h1>The POS built exclusively for phone shops</h1>
            <p>Run billing, IMEI stock, repairs and reports from one dashboard. Set up in minutes, from any device.</p>
            <div className={styles.ctaRow}>
              <Link href="/pricing" className={styles.btnLight}>Start Free Trial</Link>
              <Link href="/contact" className={styles.btnGhost}>Book Live Demo</Link>
            </div>
            <ul className={styles.trust}>
              <li>No credit card</li>
              <li>Instant access</li>
              <li>Works on every device</li>
            </ul>
          </div>
          <div className={styles.mock} aria-hidden="true">
            <div className={styles.mockKpis}>
              <div className={styles.kpi}><small>Today&apos;s sales</small><strong>Rs 1,245,000</strong></div>
              <div className={styles.kpi}><small>Phones in stock</small><strong>312</strong></div>
              <div className={styles.kpi}><small>Pending repairs</small><strong>9</strong></div>
            </div>
            <div className={styles.mockRow}><span>iPhone 15 · IMEI scanned</span><span className={`${styles.tag} ${styles.tagOk}`}>Paid</span></div>
            <div className={styles.mockRow}><span>Galaxy S24 · reorder needed</span><span className={styles.tag}>Low stock</span></div>
            <div className={styles.mockRow}><span>Screen repair #1042</span><span className={`${styles.tag} ${styles.tagOk}`}>Ready</span></div>
            <div className={styles.bars}>{[40, 65, 50, 80, 60, 90, 70].map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}</div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.head}>
            <span className={styles.eyebrow}>The problem</span>
            <h2>Why phone shops outgrow generic tools</h2>
          </div>
          <div className={styles.grid}>
            {PROBLEMS.map(([icon, t, d]) => (
              <article key={t} className={styles.card}><div className={styles.icon}>{icon}</div><h3>{t}</h3><p>{d}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.alt}`}>
        <div className={styles.wrap}>
          <div className={styles.head}>
            <span className={styles.eyebrow}>The solution</span>
            <h2>Everything a phone shop needs</h2>
            <p>One system for the counter, the stockroom and the repair bench.</p>
          </div>
          <div className={styles.grid}>
            {FEATURES.map(([t, d]) => <article key={t} className={styles.card}><h3>{t}</h3><p>{d}</p></article>)}
          </div>
          <p style={{ textAlign: 'center', marginTop: 24 }}><Link href="/features" className={styles.textLink}>Explore all features →</Link></p>
        </div>
      </section>

      <section className={styles.section}>
        <div className={`${styles.wrap} ${styles.split}`}>
          <div>
            <span className={styles.eyebrow}>Live store control</span>
            <h2 className={styles.h2}>See your whole shop in one view</h2>
            <ul className={styles.checks}>
              <li>Live sales, stock and repair numbers</li>
              <li>Profit visible only to people you allow</li>
              <li>Low-stock and overdue-repair alerts</li>
              <li>Customer SMS when a repair is ready</li>
              <li>Works on desktop, tablet and phone</li>
              <li>Switch between branches instantly</li>
            </ul>
            <Link href="/pricing" className={styles.btn}>Start Free Trial</Link>
          </div>
          <div className={styles.mock} aria-hidden="true">
            <div className={styles.mockKpis}>
              <div className={styles.kpi}><small>Sales</small><strong>Rs 84k</strong></div>
              <div className={styles.kpi}><small>Profit</small><strong>Rs 21k</strong></div>
              <div className={styles.kpi}><small>Repairs</small><strong>14</strong></div>
            </div>
            <div className={styles.bars}>{[30, 55, 45, 70, 85, 60, 75].map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}</div>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.alt}`}>
        <div className={styles.wrap}>
          <div className={styles.head}><span className={styles.eyebrow}>Why Cellivo</span><h2>Built to make your shop run better</h2></div>
          <div className={styles.grid}>
            {WHY.map(([t, d]) => <article key={t} className={styles.card}><h3>{t}</h3><p>{d}</p></article>)}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.head}><span className={styles.eyebrow}>Testimonials</span><h2>Shop owners love the difference</h2></div>
          <div className={styles.grid}>
            {REVIEWS.map(([m, q, who, biz]) => (
              <article key={m} className={styles.card}>
                <span className={styles.metric}>{m}</span>
                <p className={styles.quote}>{q}</p>
                <p className={styles.who}><strong>{who}</strong>{biz}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.alt}`}>
        <div className={styles.wrap}>
          <div className={styles.head}><span className={styles.eyebrow}>FAQ</span><h2>Frequently asked questions</h2></div>
          <div className={styles.faq}>
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>

      <CtaBand />
    </SiteShell>
  );
}

export function CtaBand() {
  return (
    <section className={styles.cta}>
      <div className={styles.wrap}>
        <h2>Ready to run your shop the easy way?</h2>
        <p>Start your free trial today. No credit card, no setup call.</p>
        <div className={styles.ctaRow}>
          <Link href="/pricing" className={styles.btnLight}>Start Free Trial</Link>
          <Link href="/pricing" className={styles.btnGhost}>View Pricing</Link>
        </div>
      </div>
    </section>
  );
}
