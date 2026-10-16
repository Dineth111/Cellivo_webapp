import Link from 'next/link';
import { FEATURE_LINKS, INDUSTRY_LINKS, LEGAL_LINKS } from './links';
import styles from './site.module.css';

// Header order as on cellivo.com; Features opens a dropdown.
const NAV_BEFORE = [['/', 'Home']];
const NAV_AFTER = [
  ['/mobile-shop-pos-system', 'Mobile Shop POS'],
  ['/pos-system-for-phone-shop', 'POS for Phone Shops'],
  ['/pricing', 'Pricing'],
  ['/blog', 'Blog'],
  ['/about', 'About'],
  ['/contact', 'Contact'],
];
export const NAV = [...NAV_BEFORE, ['/features', 'Features'], ...NAV_AFTER];
const isFeature = (p) => p === '/features' || FEATURE_LINKS.some(([h]) => h === p);

/** Shared header + footer for the public pages. `active` is the current path. */
export default function SiteShell({ active, children }) {
  const cur = (href) => (href === active || (href === '/blog' && active?.startsWith('/blog')) ? 'page' : undefined);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.bar}`}>
          <Link href="/" className={styles.logo}><span className={styles.mark}>C</span>CELLIVO</Link>
          <nav className={styles.nav} aria-label="Main">
            {NAV_BEFORE.map(([href, label]) => <Link key={href} href={href} aria-current={cur(href)}>{label}</Link>)}
            <details className={styles.drop}>
              <summary style={isFeature(active) ? { background: '#fff', color: 'var(--fg)' } : undefined}>Features ▾</summary>
              <div className={styles.dropPanel}>
                {FEATURE_LINKS.map(([href, t, d]) => <Link key={href} href={href}><strong>{t}</strong><small>{d}</small></Link>)}
                <Link href="/features" className={styles.dropAll}><strong>View all features →</strong></Link>
              </div>
            </details>
            {NAV_AFTER.map(([href, label]) => <Link key={href} href={href} aria-current={cur(href)}>{label}</Link>)}
          </nav>
          <div className={styles.actions}>
            <Link href="/login" className={`${styles.textLink} ${styles.hideSm}`}>Log in</Link>
            <Link href="/pricing" className={styles.btn}>Start Free Trial</Link>
            <details className={styles.menu}>
              <summary aria-label="Menu">☰</summary>
              <div className={styles.menuPanel}>
                {NAV.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
                <Link href="/login">Log in</Link>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main>{children}</main>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div className={styles.footGrid} style={{ gridTemplateColumns: undefined }}>
            <div>
              <Link href="/" className={styles.logo} style={{ color: '#fff' }}><span className={styles.mark}>C</span>CELLIVO</Link>
              <p style={{ margin: '12px 0 16px', maxWidth: '34ch' }}>The POS system built exclusively for phone shops, repair centers, and mobile retailers.</p>
              <Link href="/pricing" className={styles.btn} style={{ display: 'inline-flex', color: '#fff' }}>Start Free Trial</Link>
            </div>
            <div>
              <h4>Quick Links</h4>
              <Link href="/">Home</Link>
              <Link href="/about">About Us</Link>
              <Link href="/pricing">Pricing</Link>
              <Link href="/affiliate">Affiliate Program</Link>
              <Link href="/blog">Blog</Link>
              <Link href="/contact">Contact</Link>
              <a href="https://support.cellivo.com/" target="_blank" rel="noreferrer">Support</a>
            </div>
            <div>
              <h4>Features</h4>
              <Link href="/features">All Features</Link>
              {FEATURE_LINKS.slice(0, 7).map(([href, t]) => <Link key={href} href={href}>{t}</Link>)}
            </div>
            <div>
              <h4>Industries</h4>
              {INDUSTRY_LINKS.map(([href, t]) => <Link key={href} href={href}>{t}</Link>)}
              <h4 style={{ marginTop: 20 }}>Contact</h4>
              <a href="mailto:hello@cellivo.com">hello@cellivo.com</a>
              <a href="tel:+94702720000">+94 70 272 0000</a>
              <span style={{ fontSize: 14 }}>318/A/3 High Level Rd, Pannipitiya 10230, Sri Lanka</span>
            </div>
          </div>
          <div className={styles.legal}>
            <span>© 2026 Cellivo · Developed by <a href="https://w3inventor.com" target="_blank" rel="noreferrer" style={{ display: 'inline', minHeight: 0 }}>W3Inventor</a></span>
            <span>{LEGAL_LINKS.map(([href, t]) => <Link key={href} href={href}>{t}</Link>)}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
