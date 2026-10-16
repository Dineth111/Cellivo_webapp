import Link from 'next/link';
import styles from './site.module.css';

export const NAV = [
  ['/', 'Home'],
  ['/features', 'Features'],
  ['/pricing', 'Pricing'],
  ['/about', 'About'],
  ['/contact', 'Contact'],
];

/** Shared header + footer for the public pages. `active` is the current path. */
export default function SiteShell({ active, children }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.bar}`}>
          <Link href="/" className={styles.logo}><span className={styles.mark}>C</span>CELLIVO</Link>
          <nav className={styles.nav} aria-label="Main">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={href === active ? 'page' : undefined}>{label}</Link>
            ))}
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
          <div className={styles.footGrid}>
            <div>
              <Link href="/" className={styles.logo} style={{ color: '#fff' }}><span className={styles.mark}>C</span>CELLIVO</Link>
              <p style={{ marginTop: 12, maxWidth: '34ch' }}>The POS system built exclusively for phone shops, repair centers, and mobile retailers.</p>
            </div>
            <div>
              <h4>Quick Links</h4>
              {NAV.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
            </div>
            <div>
              <h4>Features</h4>
              <Link href="/features">POS Billing</Link>
              <Link href="/features">IMEI &amp; Inventory</Link>
              <Link href="/features">Repair Management</Link>
              <Link href="/features">Reports</Link>
            </div>
            <div>
              <h4>Contact</h4>
              <a href="tel:+94702720000">+94 70 272 0000</a>
              <a href="mailto:hello@cellivo.com">hello@cellivo.com</a>
              <a href="https://support.cellivo.com" target="_blank" rel="noreferrer">Support</a>
              <span>318/A/3 High Level Rd, Pannipitiya 10230, Sri Lanka</span>
            </div>
          </div>
          <div className={styles.legal}>
            <span>© 2026 Cellivo · Developed by W3Inventor</span>
            <span><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Refund Policy</a></span>
          </div>
        </div>
      </footer>
    </div>
  );
}
