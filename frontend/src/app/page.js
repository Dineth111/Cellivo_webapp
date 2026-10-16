'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { checkHealth, clearSession, getAuthProfile, hasSession, logoutUser } from '../lib/api';
import HomePage from '../components/site/HomePage';
import NotificationBell from '../components/NotificationBell';
import DashboardOverview from '../components/dashboard/DashboardOverview';
import styles from './page.module.css';

// Sidebar menu (SRS 4.1 / Figure 10.6)
const NAV = [
  { items: ['Dashboard', 'New Sale', 'Sales', 'Inventory', 'Purchases', 'Repairs', 'Customers'] },
  { label: 'Manage', items: ['Finance', 'Staff', 'Branches', 'Reports', 'Settings'] },
];
// Phone bottom tab bar (SRS 10.1 responsive): label -> page
const TABS = [['Home', 'Dashboard'], ['Sale', 'New Sale'], ['Stock', 'Inventory'], ['Repairs', 'Repairs']];

const titleCase = (name = '') => name.replace(/\b\w/g, (c) => c.toUpperCase());
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const today = () =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date()).toUpperCase();

export default function Home() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (hasSession() ? getAuthProfile() : Promise.resolve({ data: null }))
      .then(({ data }) => setUser(data))
      .catch(clearSession)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className={styles.loading}>
        <span className={styles.spinner} />
        Loading your shop
      </main>
    );
  }

  // Guests see the public marketing site; log in at /login.
  if (!user) return <HomePage />;

  return (
    <Dashboard
      user={user}
      onLogout={() => {
        logoutUser().catch(() => {});
        setUser(null);
      }}
    />
  );
}

function Dashboard({ user, onLogout }) {
  const [page, setPage] = useState('Dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dbOnline, setDbOnline] = useState(null);
  const firstName = titleCase(user.name?.split(' ')[0] || '');

  useEffect(() => {
    checkHealth()
      .then((h) => setDbOnline(h.database?.readyState === 1))
      .catch(() => setDbOnline(false));
  }, []);

  const go = (p) => {
    setPage(p);
    setMenuOpen(false);
  };

  return (
    <div className={styles.app}>
      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`}>
        <span className={styles.logo}>CELLIVO</span>
        <nav aria-label="Main">
          {NAV.map((group, i) => (
            <div key={i} className={styles.navGroup}>
              {group.label && <span className={styles.navLabel}>{group.label}</span>}
              {group.items.map((item) => (
                <button
                  key={item}
                  className={item === page ? styles.navActive : styles.navItem}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => go(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className={styles.sidebarFoot}>
          <span className={styles.status}>
            <span className={dbOnline ? styles.dotOk : styles.dotBad} />
            {dbOnline === null ? 'Checking…' : dbOnline ? 'All systems normal' : 'Server unavailable'}
          </span>
          <button className={styles.secondary} onClick={onLogout}>Log out</button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.context}>{user.shopName || 'My shop'} · Main Branch</p>
            <h1 className={styles.pageTitle}>{page}</h1>
          </div>
          <div className={styles.topActions}>
            <NotificationBell />
            <span className={styles.pill}>Main Branch</span>
            <span className={styles.avatar} title={`${titleCase(user.name)} · ${user.role?.name ?? ''}`}>
              {firstName[0]}
            </span>
            <Link className={styles.pill} href="/repairs">Repairs</Link>
            <Link className={styles.pill} href="/inventory">Inventory</Link>
            <Link className={styles.pill} href="/purchasing">Purchasing</Link>
            <Link className={styles.pill} href="/pos">POS Register</Link>
            <Link className={styles.pill} href="/billing">Billing</Link>
            <a className={styles.pill} href="https://support.cellivo.com" target="_blank" rel="noreferrer">Support</a>
          </div>
        </header>

        {page === 'Dashboard' ? (
          <DashboardOverview user={user} />
        ) : page === 'Inventory' ? (
          <article className={styles.card}>
            <h3>Inventory Management</h3>
            <p style={{ marginTop: 8, color: 'var(--secondary)' }}>
              Manage products, barcode generation & label printing, IMEI serial tracking, stock counts, and branch transfers.
            </p>
            <div style={{ marginTop: 20 }}>
              <Link className={styles.primary} href="/inventory">Open Inventory Management →</Link>
            </div>
          </article>
        ) : page === 'Purchases' ? (
          <article className={styles.card}>
            <h3>Purchasing & Suppliers</h3>
            <p style={{ marginTop: 8, color: 'var(--secondary)' }}>
              Manage suppliers, purchase orders, goods received notes (GRN), bills ageing, payments, and purchase returns.
            </p>
            <div style={{ marginTop: 20 }}>
              <Link className={styles.primary} href="/purchasing">Open Purchasing Management →</Link>
            </div>
          </article>
        ) : (
          <article className={styles.card}>
            <h3>{page}</h3>
            <p className={styles.empty}>This module is not built yet.</p>
          </article>
        )}
      </main>

      <nav className={styles.tabbar} aria-label="Quick">
        {TABS.map(([label, target]) => (
          <button key={label} className={page === target ? styles.tabActive : ''} onClick={() => go(target)}>
            {label}
          </button>
        ))}
        <button className={menuOpen ? styles.tabActive : ''} onClick={() => setMenuOpen(!menuOpen)}>More</button>
      </nav>
    </div>
  );
}
