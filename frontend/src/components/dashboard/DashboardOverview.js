'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getDashboardMetrics } from '../../lib/api';
import styles from '../../app/page.module.css';

function formatRupees(cents = 0) {
  const r = (Number(cents) || 0) / 100;
  return `Rs ${r.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function today() {
  return new Date().toLocaleDateString('en-LK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function titleCase(s = '') {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

export default function DashboardOverview({ user }) {
  const [period, setPeriod] = useState('today');
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');
  const firstName = titleCase(user.name?.split(' ')[0] || '');

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

  const periodLabel = period === 'today' ? "Today's" : period === 'this_week' ? "This Week's" : "This Month's";

  return (
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
  );
}
