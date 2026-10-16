import SiteShell from '../../components/site/SiteShell';
import PricingTable from '../../components/site/PricingTable';
import styles from '../../components/site/site.module.css';

export const metadata = { title: 'Pricing | Cellivo', description: 'Simple pricing for phone shops. Start free, no credit card.' };

const FAQ = [
  ['Do I need a credit card to start?', 'No. The free trial needs no card.'],
  ['Can I upgrade or switch plans later?', 'Yes, from the billing page at any time.'],
  ['What is included in Lifetime?', 'A one-time payment for the plan you choose, with no renewals.'],
  ['Can I cancel anytime?', 'Yes. There is no commitment.'],
];

export default function PricingPage() {
  return (
    <SiteShell active="/pricing">
      <section className={`${styles.section} ${styles.alt}`}>
        <div className={styles.wrap}>
          <div className={styles.head}>
            <span className={styles.eyebrow}>Pricing</span>
            <h2>Simple pricing for every phone shop</h2>
            <p>Start free. Pick a plan when you are ready.</p>
          </div>
          <PricingTable />
        </div>
      </section>
      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.head}><h2>Pricing questions</h2></div>
          <div className={styles.faq}>
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
