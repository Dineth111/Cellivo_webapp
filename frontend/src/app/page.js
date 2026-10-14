'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { checkHealth, clearSession, getAuthProfile, hasSession, loginUser, logoutUser, registerUser, saveSession, getDashboardMetrics } from '../lib/api';
import NotificationBell from '../components/NotificationBell';
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

  if (!user) return <Login onLogin={setUser} />;

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
      saveSession(res, isLogin ? form.remember : true);
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
              {...(!isLogin && { minLength: 8, pattern: '(?=.*[A-Za-z])(?=.*[0-9]).{8,}', title: 'At least 8 characters, with a letter and a number' })}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
            />
            {!isLogin && <span className={styles.caption}>At least 8 characters, with a letter and a number.</span>}
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
            {isLogin ? <Link href="/signup">Start free trial</Link> : <button type="button" onClick={switchMode}>Log in</button>}
          </p>
        </form>
      </section>
    </main>
  );
}

function formatRupees(cents = 0) {
  const r = (Number(cents) || 0) / 100;
  return `Rs ${r.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Dashboard({ user, onLogout }) {
  const [page, setPage] = useState('Dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dbOnline, setDbOnline] = useState(null);
  const [period, setPeriod] = useState('today');
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');
  const firstName = titleCase(user.name.split(' ')[0]);

  useEffect(() => {
    checkHealth()
      .then((h) => setDbOnline(h.database?.readyState === 1))
      .catch(() => setDbOnline(false));
  }, []);

  const handlePeriodChange = (p) => {
    setPeriod(p);
    setMetricsLoading(true);
  };

  useEffect(() => {
    let active = true;
    getDashboardMetrics({ period })
      .then((data) => {
        if (active) {
          setMetrics(data);
          setMetricsError('');
        }
      })
      .catch((err) => {
        if (active) setMetricsError(err.message || 'Failed to load dashboard metrics');
      })
      .finally(() => {
        if (active) setMetricsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [period]);

  const go = (p) => {
    setPage(p);
    setMenuOpen(false);
  };

  const periodLabel = period === 'today' ? "Today's" : period === 'this_week' ? "This Week's" : "This Month's";

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
          <>
            <section className={styles.hero}>
              <div>
                <span className={styles.badgeDark}>{today()}</span>
                <h2>{greeting()}, {firstName}</h2>
                <p>Overview of sales, repairs, inventory stock, and receivables.</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 16 }}>
                  {[
                    ['today', 'Today'],
                    ['this_week', 'This Week'],
                    ['this_month', 'This Month'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handlePeriodChange(key)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 999,
                        border: '1px solid',
                        borderColor: period === key ? '#fff' : 'rgba(255, 255, 255, 0.35)',
                        background: period === key ? 'rgba(255, 255, 255, 0.25)' : 'transparent',
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className={styles.heroActions}>
                  <Link className={styles.primary} href="/pos">+ New Sale</Link>
                  <Link className={styles.outlineDark} href="/repairs/new">+ New Repair</Link>
                  <Link className={styles.outlineDark} href="/inventory">+ Add Stock</Link>
                </div>
              </div>
              <div className={styles.glassRow}>
                <div className={styles.glass}>
                  <span className={styles.labelDark}>Active Repairs</span>
                  <strong>{metrics?.activeRepairsCount ?? 0}</strong>
                  <small>in progress / inspection</small>
                </div>
                <div className={styles.glass}>
                  <span className={styles.labelDark}>Low Stock</span>
                  <strong>{metrics?.lowStockCount ?? 0}</strong>
                  <small>items below reorder level</small>
                </div>
              </div>
            </section>

            {metricsError ? (
              <div style={{ padding: '12px 16px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
                {metricsError}
              </div>
            ) : null}

            <section className={styles.stats}>
              <Stat
                label={`${periodLabel} sales`}
                value={formatRupees(metrics?.sales?.totalCents ?? 0)}
                helper={`${metrics?.sales?.count ?? 0} settled invoices`}
              />
              <Stat
                label="Active repairs"
                value={String(metrics?.activeRepairsCount ?? 0)}
                helper="Received to quality check"
              />
              <Stat
                label="Low stock items"
                value={String(metrics?.lowStockCount ?? 0)}
                helper="At or below reorder level"
              />
              <Stat
                label="Pending receivables"
                value={formatRupees(metrics?.receivables?.totalCents ?? 0)}
                helper={`${metrics?.receivables?.unpaidInvoicesCount ?? 0} unpaid balances`}
              />
            </section>

            <section className={styles.panels}>
              <article className={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>Overdue Repairs</h3>
                  <Link href="/repairs" style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)', textDecoration: 'none' }}>
                    All repairs →
                  </Link>
                </div>
                {metricsLoading ? (
                  <p className={styles.empty}>Loading overdue repairs...</p>
                ) : metrics?.overdueRepairs && metrics.overdueRepairs.length > 0 ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {metrics.overdueRepairs.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 12px',
                          borderRadius: 8,
                          background: '#fef2f2',
                          border: '1px solid #fee2e2',
                        }}
                      >
                        <div>
                          <Link
                            href={`/repairs/${item.id}`}
                            style={{ fontWeight: 700, color: '#b91c1c', textDecoration: 'none', fontSize: 14 }}
                          >
                            {item.ticketNo}
                          </Link>
                          <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>
                            {item.device.brand} {item.device.model} {item.customer?.name ? `· ${item.customer.name}` : ''}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              background: '#ef4444',
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: 999,
                            }}
                          >
                            {item.daysOverdue}d overdue
                          </span>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                            Stage: {item.stage}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.empty}>No overdue repairs. All jobs are on track!</p>
                )}
              </article>

              <article className={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>Recent Activity</h3>
                  <span style={{ fontSize: 12, color: 'var(--secondary)' }}>Last 10 events</span>
                </div>
                {metricsLoading ? (
                  <p className={styles.empty}>Loading recent activity...</p>
                ) : metrics?.recentActivity && metrics.recentActivity.length > 0 ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {metrics.recentActivity.map((evt, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: '#f9fafb',
                          border: '1px solid #f3f4f6',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 800,
                              padding: '3px 8px',
                              borderRadius: 6,
                              textTransform: 'uppercase',
                              background:
                                evt.type === 'sale'
                                  ? '#ecfdf5'
                                  : evt.type === 'repair_intake'
                                  ? '#eff6ff'
                                  : '#fef3c7',
                              color:
                                evt.type === 'sale'
                                  ? '#047857'
                                  : evt.type === 'repair_intake'
                                  ? '#1d4ed8'
                                  : '#b45309',
                            }}
                          >
                            {evt.type === 'sale' ? 'Sale' : evt.type === 'repair_intake' ? 'Intake' : 'Stage'}
                          </span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}>
                              {evt.title}
                            </div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>
                              {evt.description}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {evt.amountCents ? (
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#047857' }}>
                              {formatRupees(evt.amountCents)}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.empty}>No recent sales or repair activity recorded yet.</p>
                )}
              </article>
            </section>
          </>
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

function Stat({ label, value, helper }) {
  return (
    <article className={styles.card}>
      <span className={styles.label}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      <span className={styles.caption}>{helper}</span>
    </article>
  );
}
