'use client';

import { useEffect, useState } from 'react';
import { checkHealth, getAuthProfile, loginUser, registerUser } from '../lib/api';
import styles from './page.module.css';

const TOKEN_KEY = 'cellivo_jwt';

// Sidebar menu (SRS 4.1 / Figure 10.6)
const NAV = [
  { items: ['Dashboard', 'New Sale', 'Sales', 'Inventory', 'Purchases', 'Repairs', 'Customers'] },
  { label: 'Manage', items: ['Finance', 'Staff', 'Branches', 'Reports', 'Settings'] },
];
// Phone bottom tab bar (SRS 10.1 responsive): label -> page
const TABS = [['Home', 'Dashboard'], ['Sale', 'New Sale'], ['Stock', 'Inventory'], ['Repairs', 'Repairs']];

const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
};
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
    const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    (token ? getAuthProfile(token) : Promise.resolve({ data: null }))
      .then(({ data }) => setUser(data))
      .catch(clearToken)
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

  if (!user) return <Login onLogin={setUser} />;

  return (
    <Dashboard
      user={user}
      onLogout={() => {
        clearToken();
        setUser(null);
      }}
    />
  );
}

function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', shopName: '', email: '', phone: '', password: '', remember: true });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isLogin = mode === 'login';
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = isLogin ? await loginUser(form) : await registerUser(form);
      (isLogin && !form.remember ? sessionStorage : localStorage).setItem(TOKEN_KEY, res.token);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode(isLogin ? 'register' : 'login');
    setError('');
  };

  return (
    <main className={styles.authShell}>
      <section className={styles.authHero}>
        <span className={styles.badgeDark}>Mobile shop POS</span>
        <div>
          <h1>Run billing, IMEI stock and repairs from one dashboard.</h1>
          <p>Works on desktop, tablet and mobile. No IT setup needed.</p>
        </div>
        <div className={styles.glassRow}>
          <div className={styles.glass}>
            <span className={styles.labelDark}>Today&apos;s sales</span>
            <strong>Rs 1,245,000</strong>
          </div>
          <div className={styles.glass}>
            <span className={styles.labelDark}>Repairs ready</span>
            <strong>3</strong>
          </div>
        </div>
      </section>

      <section className={styles.authPanel}>
        <form className={styles.authForm} onSubmit={submit}>
          <span className={styles.logo}>CELLIVO</span>
          <div>
            <h2>{isLogin ? 'Welcome back' : 'Create your Cellivo account'}</h2>
            <p className={styles.caption}>
              {isLogin ? 'Log in to your shop account' : 'No credit card required · Cancel anytime'}
            </p>
          </div>

          {error && <div className={styles.error} role="alert">{error}</div>}

          {!isLogin && (
            <>
              <label>
                Full name
                <input value={form.name} onChange={set('name')} placeholder="Nimal Perera" required />
              </label>
              <label>
                Shop name
                <input value={form.shopName} onChange={set('shopName')} placeholder="Nimal Mobile" required />
              </label>
              <label>
                Mobile number
                <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+94 77 123 4567" />
              </label>
            </>
          )}
          <label>
            Email
            <input type="email" value={form.email} onChange={set('email')} placeholder="you@shop.com" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={set('password')}
              minLength={6}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
            />
          </label>

          {isLogin && (
            <label className={styles.checkbox}>
              <input type="checkbox" checked={form.remember} onChange={set('remember')} />
              Remember this device
            </label>
          )}

          <button className={styles.primary} disabled={submitting}>
            {submitting ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
          </button>

          <p className={styles.switch}>
            {isLogin ? 'New to Cellivo? ' : 'Already have an account? '}
            <button type="button" onClick={switchMode}>
              {isLogin ? 'Start free trial' : 'Log in'}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ user, onLogout }) {
  const [page, setPage] = useState('Dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dbOnline, setDbOnline] = useState(null);
  const firstName = titleCase(user.name.split(' ')[0]);

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
            <span className={styles.pill}>Main Branch</span>
            <span className={styles.avatar} title={`${titleCase(user.name)} · ${user.role.replace('_', ' ')}`}>
              {firstName[0]}
            </span>
            <a className={styles.pill} href="https://support.cellivo.com" target="_blank" rel="noreferrer">Support</a>
          </div>
        </header>

        {page === 'Dashboard' ? (
          <>
            <section className={styles.hero}>
              <div>
                <span className={styles.badgeDark}>{today()}</span>
                <h2>{greeting()}, {firstName}</h2>
                <p>Today&apos;s sales will show here once you make your first sale.</p>
                <div className={styles.heroActions}>
                  <button className={styles.primary} onClick={() => go('New Sale')}>+ New Sale</button>
                  <button className={styles.outlineDark} onClick={() => go('Repairs')}>+ New Repair</button>
                  <button className={styles.outlineDark} onClick={() => go('Inventory')}>+ Add Stock</button>
                </div>
              </div>
              <div className={styles.glassRow}>
                <div className={styles.glass}>
                  <span className={styles.labelDark}>Repairs ready</span>
                  <strong>0</strong>
                  <small>for pickup today</small>
                </div>
                <div className={styles.glass}>
                  <span className={styles.labelDark}>Reorder</span>
                  <strong>0</strong>
                  <small>items below level</small>
                </div>
              </div>
            </section>

            {/* ponytail: placeholder figures until sales/inventory/repair modules exist */}
            <section className={styles.stats}>
              <Stat label="Today's sales" value="Rs 0" helper="No sales yet" />
              <Stat label="Phones in stock" value="0" helper="Add stock to begin" />
              <Stat label="Repairs pending" value="0" helper="0 ready for pickup" />
              <Stat label="This month's profit" value="Rs 0" helper="Vs last month" />
            </section>

            <section className={styles.panels}>
              <article className={styles.card}>
                <h3>Revenue vs Profit</h3>
                <p className={styles.empty}>No sales data for this period yet.</p>
              </article>
              <article className={styles.card}>
                <h3>Last sales</h3>
                <p className={styles.empty}>No invoices yet.</p>
                <button className={styles.primary} onClick={() => go('New Sale')}>Make first sale</button>
              </article>
            </section>
          </>
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

function Stat({ label, value, helper }) {
  return (
    <article className={styles.card}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      <span className={styles.caption}>{helper}</span>
    </article>
  );
}
