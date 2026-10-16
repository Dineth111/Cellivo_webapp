import SiteShell from '../../components/site/SiteShell';
import { CtaBand } from '../../components/site/HomePage';
import styles from '../../components/site/site.module.css';

export const metadata = { title: 'About | Cellivo', description: 'Cellivo is a POS built for phone shops by W3Inventor, Sri Lanka.' };

const VALUES = [
  ['Innovation', 'Continuously evolving the platform with new technology.'],
  ['Reliability', 'Uptime, secure data handling and consistent performance.'],
  ['Business Impact', 'Every feature should deliver measurable value.'],
  ['Partnership', 'A technology partner, not just a software seller.'],
  ['Growth', 'Scaling from a single shop to a nationwide chain.'],
  ['Transparency', 'Clear pricing and honest communication.'],
];

export default function AboutPage() {
  return (
    <SiteShell active="/about">
      <section className={styles.hero}>
        <div className={styles.wrap}>
          <span className={styles.badge}>About Cellivo</span>
          <h1>A POS that understands mobile retail</h1>
          <p>Empower every phone shop with intelligent, easy-to-use technology that drives real business results.</p>
        </div>
      </section>
      <section className={styles.section}>
        <div className={`${styles.wrap} ${styles.split}`}>
          <div>
            <h2 className={styles.h2}>Our story</h2>
            <p style={{ marginTop: 12 }}>Most phone shops use generic POS systems or spreadsheets that do not fit their work. Owners struggled with IMEI tracking, lost devices during repairs and miscounted accessories.</p>
            <p style={{ marginTop: 12 }}>Cellivo was built from the ground up for phone shops by W3Inventor, a Sri Lanka-based software company, working directly with shop owners.</p>
          </div>
          <div className={styles.stats}>
            <div className={styles.card + ' ' + styles.stat}><strong>99.9%</strong>uptime</div>
            <div className={styles.card + ' ' + styles.stat}><strong>500+</strong>phone shops</div>
          </div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.alt}`}>
        <div className={styles.wrap}>
          <div className={styles.head}>
            <h2>Vision</h2>
            <p>A world where every mobile retailer has access to enterprise-grade tools without enterprise complexity.</p>
          </div>
          <div className={styles.grid}>
            {VALUES.map(([t, d]) => <article key={t} className={styles.card}><h3>{t}</h3><p>{d}</p></article>)}
          </div>
        </div>
      </section>
      <CtaBand />
    </SiteShell>
  );
}
