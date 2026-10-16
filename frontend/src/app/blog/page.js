import Link from 'next/link';
import SiteShell from '../../components/site/SiteShell';
import { CtaBand } from '../../components/site/HomePage';
import { BLOG, POSTS } from '../../components/site/siteContent';
import styles from '../../components/site/site.module.css';

export const metadata = { title: 'Phone Shop POS Blog & Guides | Cellivo', description: 'Guides on POS systems, IMEI tracking, inventory and repairs for phone shop owners.' };

export default function BlogIndex() {
  return (
    <SiteShell active="/blog">
      <section className={styles.hero}>
        <div className={styles.wrap} style={{ maxWidth: 900, textAlign: 'center' }}>
          <span className={styles.badge}>Blog</span>
          <h1>{BLOG.h1}</h1>
          {BLOG.intro.map((p) => <p key={p} style={{ marginInline: 'auto', marginBottom: 12 }}>{p}</p>)}
          <div className={styles.ctaRow} style={{ justifyContent: 'center' }}>
            <Link href="/mobile-shop-pos-system" className={styles.btn}>View Full POS System</Link>
            <Link href="/pos-system-for-phone-shop" className={styles.btnGhost}>View POS for Phone Shops</Link>
          </div>
        </div>
      </section>
      <section className={styles.section}>
        <div className={`${styles.wrap} ${styles.posts}`}>
          {Object.entries(POSTS).map(([slug, p]) => (
            <Link key={slug} href={`/blog/${slug}`} className={`${styles.card} ${styles.post}`}>
              <h2>{p.h1}</h2>
              <p>{p.excerpt}</p>
              <span>Read article →</span>
            </Link>
          ))}
        </div>
      </section>
      <CtaBand title="Ready to Try Cellivo?" text="Start managing your phone shop with the POS system built for mobile retail." />
    </SiteShell>
  );
}
