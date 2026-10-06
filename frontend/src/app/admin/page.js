'use client';

import { useEffect, useState } from 'react';
import { admin, adminEnroll, adminLogin, adminLogout, adminToken, adminVerify, saveAdminToken } from '../../lib/adminApi';
import { COLLECTIONS, Collection } from './Collections';
import { Alert, AppHeader, Badge, Button, Card, Chip, Field, Hero, Spinner, Stat, StatGrid, Table, User, date, money } from '../../components/ui';
import layout from './admin.module.css';

// Which tabs each admin role sees. The API enforces the same rules; this only hides what would be refused.
const TABS = [
  ['Dashboard', null],
  ['Shops', null],
  ['Payments', ['finance', 'support']],
  ['Plans', ['finance']],
  ['Leads', ['sales', 'support']],
  ['Audit', ['finance']],
];
const can = (role, roles) => role === 'super_admin' || !roles || roles.includes(role);

/** Platform admin console (FRS section 4). Separate login from the shop app. */
export default function AdminPage() {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (adminToken() ? admin('/me').then((r) => setMe(r.data)).catch(() => {}) : Promise.resolve()).then(() => setReady(true));
  }, []);

  if (!ready) return <Wrap><Spinner /></Wrap>;
  if (!me) return <Wrap><Login onDone={setMe} /></Wrap>;
  return <Console me={me} onLogout={() => adminLogout().then(() => setMe(null))} />;
}

const Wrap = ({ children }) => (
  <main style={{ maxWidth: 1100, margin: '32px auto', padding: '0 16px', display: 'grid', gap: 16 }}>{children}</main>
);

function Login({ onDone }) {
  const [step, setStep] = useState('password');
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [challenge, setChallenge] = useState('');
  const [secret, setSecret] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const run = (fn) => async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const password = run(async () => {
    const r = await adminLogin(f.email, f.password);
    setChallenge(r.challenge);
    if (!r.twoFactorEnrolled) setSecret(await adminEnroll(r.challenge)); // first login: show the authenticator secret
    setStep('code');
  });
  const code = run(async () => {
    const r = await adminVerify(challenge, f.code);
    saveAdminToken(r.token);
    onDone(r.admin);
  });

  return (
    <div style={{ maxWidth: 420, margin: '60px auto', display: 'grid', gap: 16, width: '100%' }}>
      <h1 style={{ color: 'var(--heading)' }}>Cellivo admin</h1>
      {error && <Alert tone="danger">{error}</Alert>}
      {step === 'password' ? (
        <Card>
          <form onSubmit={password} style={{ display: 'grid', gap: 14 }}>
            <Field label="Email" type="email" value={f.email} onChange={set('email')} autoComplete="username" required />
            <Field label="Password" type="password" value={f.password} onChange={set('password')} autoComplete="current-password" required />
            <Button disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</Button>
          </form>
        </Card>
      ) : (
        <Card title="Two-factor code">
          {secret && (
            <Alert>
              Set up your authenticator app first: add an account with this key (time-based, 6 digits).
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', margin: '8px 0' }}><strong>{secret.secret}</strong></div>
            </Alert>
          )}
          <form onSubmit={code} style={{ display: 'grid', gap: 14 }}>
            <Field label="6-digit code" value={f.code} onChange={set('code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
            <Button disabled={busy}>{busy ? 'Please wait…' : 'Log in'}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function Console({ me, onLogout }) {
  const [tab, setTab] = useState('Dashboard');
  const tabs = [...TABS, ...Object.entries(COLLECTIONS).map(([name, c]) => [name, c.roles])].filter(([, roles]) => can(me.role, roles));
  const allowed = new Set(tabs.map(([t]) => t));
  const grouped = new Set(NAV.flatMap((g) => g.items.map(([t]) => t)));
  const groups = [
    ...NAV.map((g) => ({ ...g, items: g.items.filter(([t]) => allowed.has(t)) })),
    { label: 'More', items: tabs.filter(([t]) => !grouped.has(t)).map(([t]) => [t, t]) },
  ].filter((g) => g.items.length);

  return (
    <>
      <AppHeader chip={`Platform ${me.role.replace('_', '-')}`}>
        <Chip ok>2FA active</Chip>
        <User name={me.name} />
        <Button variant="secondary" onClick={onLogout}>Log out</Button>
      </AppHeader>
      <div className={layout.shell}>
        <nav className={layout.side} aria-label="Admin sections">
          {groups.map((g) => (
            <div key={g.label} className={layout.group}>
              <span className={layout.groupLabel}>{g.label}</span>
              {g.items.map(([t, label]) => (
                <button key={t} className={t === tab ? layout.active : layout.item} aria-current={t === tab ? 'page' : undefined} onClick={() => setTab(t)}>{label}</button>
              ))}
            </div>
          ))}
        </nav>
        <main className={layout.content}>
          {tab === 'Dashboard' && <Dashboard role={me.role} />}
          {tab === 'Shops' && <Shops role={me.role} />}
          {tab === 'Payments' && <Payments role={me.role} />}
          {tab === 'Plans' && <Plans />}
          {tab === 'Leads' && <Leads />}
          {tab === 'Audit' && <Audit />}
          {COLLECTIONS[tab] && <Collection key={tab} cfg={COLLECTIONS[tab]} title={tab} />}
        </main>
      </div>
    </>
  );
}

// Sidebar grouping: [tab key, label shown]. Tabs the role cannot use are dropped; unlisted ones go under "More".
const NAV = [
  { label: 'Core admin', items: [['Dashboard', 'Overview KPIs'], ['Shops', 'Tenants & Shops'], ['Plans', 'Plans & Features'], ['Payments', 'Payments & Ledger']] },
  { label: 'Growth & support', items: [['Leads', 'Leads & Demos'], ['Affiliates', 'Affiliates'], ['Website', 'Website CMS'], ['Tickets', 'Support Tickets'], ['Audit', 'Audit Log']] },
];

/** Loads a list endpoint; `deps` re-fetches. Returns [rows, error, reload]. */
function useList(path) {
  const [state, setState] = useState({ rows: null, total: 0, error: '' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    admin(path)
      .then((r) => live && setState({ rows: r.data, total: r.total ?? r.data.length, error: '' }))
      .catch((e) => live && setState({ rows: [], total: 0, error: e.message }));
    return () => { live = false; };
  }, [path, n]);
  return [state, () => setN((x) => x + 1)];
}

function Dashboard({ role }) {
  const [state] = useList('/dashboard');
  const d = state.rows;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (!d) return <Spinner />;
  const run = billingRunnable(role);
  return (
    <>
      <Hero
        badges={[[`${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} · Platform overview`, true]]}
        title={Object.keys(d.revenueLast30Days).length ? Object.entries(d.revenueLast30Days).map(([c, v]) => money(v, c)).join(' + ') : 'No revenue yet'}
        subtitle="Revenue in the last 30 days"
        aside={[
          { label: 'Failed payments', value: d.failedPayments30d, helper: d.failedPayments30d ? 'Retries run on days 1, 3 and 5' : 'None in 30 days' },
          { label: 'Trials ending (3 days)', value: d.trialsEnding3d, helper: d.trialsEnding3d ? 'Worth a follow-up' : 'Nothing due' },
        ]}
      />
      <StatGrid>
        <Stat label="Active paid shops" value={d.tenantsByStatus.active ?? 0} helper={Object.entries(d.activeByPlan).map(([k, v]) => `${k} ${v}`).join(' · ') || 'No active plans'} />
        <Stat label="On trial" value={d.tenantsByStatus.trial ?? 0} helper={`${d.tenantsByStatus.expired ?? 0} expired`} />
        <Stat label="Needs attention" value={(d.tenantsByStatus.past_due ?? 0) + (d.tenantsByStatus.suspended ?? 0)} helper={`${d.tenantsByStatus.past_due ?? 0} past due · ${d.tenantsByStatus.suspended ?? 0} suspended`} />
        <Stat label="To do" value={d.newLeads + d.openTickets} helper={`${d.newLeads} new leads · ${d.openTickets} open tickets`} />
      </StatGrid>
      <Card title="Billing job">
        <span>{d.lastBillingRun ? `Last run ${date(d.lastBillingRun.at)}: ${d.lastBillingRun.renewed} renewed, ${d.lastBillingRun.failed} failed, ${d.lastBillingRun.errors} errors` : 'Has not run since the server started.'}</span>
        {run && <RunBilling />}
      </Card>
    </>
  );
}
const billingRunnable = (role) => role === 'super_admin' || role === 'finance';

function RunBilling() {
  const [msg, setMsg] = useState('');
  const go = () => window.confirm('Run renewals and retries now?') && admin('/billing/run', { method: 'POST' })
    .then((r) => setMsg(`Done: ${r.data.renewed} renewed, ${r.data.failed} failed, ${r.data.suspended} suspended.`))
    .catch((e) => setMsg(e.message));
  return <><Button variant="secondary" onClick={go}>Run billing now</Button>{msg && <span>{msg}</span>}</>;
}

const TONE = { active: 'success', trial: undefined, past_due: 'warning', suspended: 'danger', expired: 'warning', cancelled: 'warning', archived: 'danger' };

function Shops({ role }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [state, reload] = useList(`/tenants?q=${encodeURIComponent(q)}&status=${status}`);
  if (open) return <Shop id={open} role={role} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <Card title="Shops">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone" />
        <Field label="Status" as="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['trial', 'active', 'past_due', 'suspended', 'expired', 'cancelled', 'archived'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </Field>
      </div>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {!state.rows ? <Spinner /> : (
        <Table head={['Shop', 'Owner', 'Plan', 'Status', 'Joined', '']}>
          {state.rows.map((t) => (
            <tr key={t._id}>
              <td>{t.name}</td><td>{t.ownerEmail}</td><td>{t.planCode ?? '-'}</td>
              <td><Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge></td>
              <td>{date(t.createdAt)}</td>
              <td><Button variant="secondary" onClick={() => setOpen(t._id)}>Open</Button></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// [path, label, extra fields to ask for]. Every action asks for a reason; the server rejects it without one.
const ACTIONS = [
  ['suspend', 'Suspend', []],
  ['reactivate', 'Reactivate', []],
  ['extend-trial', 'Extend trial', [['days', 'Days']]],
  ['free-period', 'Free period', [['days', 'Days']]],
  ['branch-limit', 'Branch limit', [['limit', 'Limit']]],
  ['sms-credits', 'SMS credits', [['delta', '+/- credits']]],
];

function Shop({ id, role, onBack }) {
  const [state, reload] = useList(`/tenants/${id}`);
  const [action, setAction] = useState(ACTIONS[0][0]);
  const [vals, setVals] = useState({});
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState({ tone: 'success', text: '' });
  const t = state.rows;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (!t) return <Spinner />;
  const fields = ACTIONS.find((a) => a[0] === action)[2];

  const post = (path, body, done) => admin(`/tenants/${id}/${path}`, { method: 'POST', body })
    .then(() => { setMsg({ tone: 'success', text: done }); reload(); })
    .catch((e) => setMsg({ tone: 'danger', text: e.message }));
  const submit = (e) => {
    e.preventDefault();
    const body = { reason };
    for (const [k] of fields) body[k] = vals[k] === '' || vals[k] === undefined ? null : Number(vals[k]);
    post(action, body, 'Done.');
  };

  return (
    <>
      <Button variant="secondary" onClick={onBack}>Back to shops</Button>
      {msg.text && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <section style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <Card title={t.name}>
          <Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge>
          <span>{t.ownerName} · {t.ownerEmail} · {t.phone}</span>
          <span>Plan: {t.planCode ?? 'none'} ({t.billingTerm}, {t.billingCurrency})</span>
          <span>Trial ends: {date(t.trialEndsAt)} · Renews: {date(t.subscription.currentPeriodEnd)}</span>
          <span>Users {t.counts.users} · Branches {t.counts.branches} (override {t.branchLimitOverride ?? 'none'}) · SMS {t.smsCredits}</span>
          <span>Card: {t.paymentMethod?.last4 ? `${t.paymentMethod.brand} ${t.paymentMethod.last4}` : 'none'}</span>
        </Card>
        <Card title="Take action">
          <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
            <Field label="Action" as="select" value={action} onChange={(e) => { setAction(e.target.value); setVals({}); }}>
              {ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Field>
            {fields.map(([k, l]) => <Field key={k} label={l} type="number" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />)}
            <Field label="Reason (saved in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} required />
            <Button>Apply</Button>
          </form>
        </Card>
        <Card title="Notes">
          {t.notes.map((n, i) => <span key={i}>{n.text} <small>({n.by}, {date(n.at)})</small></span>)}
          <form onSubmit={(e) => { e.preventDefault(); post('notes', { text: note }, 'Note added.'); setNote(''); }} style={{ display: 'grid', gap: 8 }}>
            <Field label="New note" value={note} onChange={(e) => setNote(e.target.value)} required />
            <Button variant="secondary">Add note</Button>
          </form>
        </Card>
      </section>
      {can(role, ['finance']) && <OfflinePayment id={id} onDone={(text) => { setMsg({ tone: 'success', text }); reload(); }} onError={(text) => setMsg({ tone: 'danger', text })} />}
      <Card title="Invoices">
        <Table head={['Number', 'Date', 'Plan', 'Total', 'Status']}>
          {t.invoices.map((i) => <tr key={i._id}><td>{i.number}</td><td>{date(i.paidAt)}</td><td>{i.planCode} ({i.term})</td><td>{money(i.total, i.currency)}</td><td>{i.status.replace('_', ' ')}</td></tr>)}
        </Table>
      </Card>
    </>
  );
}

function Payments({ role }) {
  const [status, setStatus] = useState('');
  const [inv, reload] = useList('/invoices');
  const [pay] = useList(`/payments?status=${status || 'failed'}`);
  const [msg, setMsg] = useState('');
  const refund = (i) => {
    const reason = window.prompt(`Refund ${i.number} in full. Reason?`);
    if (!reason) return;
    admin(`/invoices/${i._id}/refund`, { method: 'POST', body: { reason } }).then(() => { setMsg('Refunded.'); reload(); }).catch((e) => setMsg(e.message));
  };
  return (
    <>
      {msg && <Alert>{msg}</Alert>}
      <Card title="Invoices">
        {!inv.rows ? <Spinner /> : (
          <Table head={['Number', 'Date', 'Plan', 'Total', 'Status', '']}>
            {inv.rows.map((i) => (
              <tr key={i._id}>
                <td>{i.number}</td><td>{date(i.paidAt)}</td><td>{i.planCode} ({i.term})</td><td>{money(i.total, i.currency)}</td><td>{i.status.replace('_', ' ')}</td>
                <td>{role !== 'support' && i.status === 'paid' && <Button variant="secondary" onClick={() => refund(i)}>Refund</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Failed charges">
        <Field label="Show" as="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Failed</option><option value="paid">Paid</option>
        </Field>
        {!pay.rows ? <Spinner /> : (
          <Table head={['Date', 'Amount', 'Attempt', 'Error']}>
            {pay.rows.map((p) => <tr key={p._id}><td>{date(p.createdAt)}</td><td>{money(p.amount, p.currency)}</td><td>{p.attempt}</td><td>{p.error}</td></tr>)}
          </Table>
        )}
      </Card>
    </>
  );
}

function Plans() {
  const [state, reload] = useList('/plans');
  const [msg, setMsg] = useState('');
  const edit = (p) => {
    const raw = window.prompt(`New LKR monthly price for ${p.name}`, p.prices.monthly.LKR);
    if (raw === null) return;
    const n = Number(raw);
    if (!(n >= 0)) return setMsg('Enter a price of 0 or more.');
    admin(`/plans/${p.code}`, { method: 'PUT', body: { prices: { ...p.prices, monthly: { ...p.prices.monthly, LKR: n } } } })
      .then(() => { setMsg('Saved. New purchases and renewals use the new price; issued invoices keep theirs.'); reload(); })
      .catch((e) => setMsg(e.message));
  };
  return (
    <Card title="Plans">
      {msg && <Alert>{msg}</Alert>}
      {!state.rows ? <Spinner /> : (
        <Table head={['Plan', 'Monthly (LKR)', 'Yearly (LKR)', 'Branches', 'Trial days', '']}>
          {state.rows.map((p) => (
            <tr key={p.code}>
              <td>{p.name}</td><td>{p.prices.monthly.LKR}</td><td>{p.prices.yearly.LKR}</td><td>{p.branchLimit ?? 'unlimited'}</td><td>{p.trialDays}</td>
              <td><Button variant="secondary" onClick={() => edit(p)}>Edit price</Button></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

const LEAD_STATUSES = ['new', 'contacted', 'demo_scheduled', 'demo_done', 'converted', 'lost'];
function Leads() {
  const [state, reload] = useList('/leads');
  const [msg, setMsg] = useState('');
  const setStatus = (l, status) => admin(`/leads/${l._id}`, { method: 'PUT', body: { status } }).then(reload).catch((e) => setMsg(e.message));
  return (
    <Card title="Leads">
      {msg && <Alert tone="danger">{msg}</Alert>}
      {!state.rows ? <Spinner /> : (
        <Table head={['Date', 'Type', 'Name', 'Email', 'Message', 'Status']}>
          {state.rows.map((l) => (
            <tr key={l._id}>
              <td>{date(l.createdAt)}</td><td>{l.kind}</td><td>{l.name}{l.shopName ? ` (${l.shopName})` : ''}</td><td>{l.email}</td><td>{l.message}</td>
              <td>
                <select value={l.status} onChange={(e) => setStatus(l, e.target.value)} aria-label={`Status of ${l.name}`}>
                  {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Audit() {
  const [state] = useList('/audit');
  return (
    <Card title="Platform audit log">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {!state.rows ? <Spinner /> : (
        <Table head={['When', 'Who', 'Action', 'Reason']}>
          {state.rows.map((a) => <tr key={a._id}><td>{new Date(a.at).toLocaleString('en-GB')}</td><td>{a.actor?.name}</td><td>{a.action}</td><td>{a.reason}</td></tr>)}
        </Table>
      )}
    </Card>
  );
}

// A-03: a bank transfer received outside the card gateway activates the plan and creates the invoice.
function OfflinePayment({ id, onDone, onError }) {
  const [v, setV] = useState({ planCode: 'starter', term: 'monthly', currency: 'LKR', amount: '', reference: '' });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    admin(`/tenants/${id}/offline-payment`, { method: 'POST', body: { ...v, amount: v.amount === '' ? undefined : Number(v.amount) } })
      .then((r) => onDone(`Plan activated. Invoice ${r.data.number} created.`))
      .catch((err) => onError(err.message));
  };
  return (
    <Card title="Record a bank transfer">
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field label="Plan code" value={v.planCode} onChange={set('planCode')} hint="lite, starter, growth, business" required />
        <Field label="Billing" as="select" value={v.term} onChange={set('term')}><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="lifetime">Lifetime</option></Field>
        <Field label="Currency" as="select" value={v.currency} onChange={set('currency')}><option value="LKR">LKR</option><option value="USD">USD</option></Field>
        <Field label="Amount received (empty = list price)" type="number" step="any" value={v.amount} onChange={set('amount')} />
        <Field label="Bank reference" value={v.reference} onChange={set('reference')} />
        <Button>Activate plan</Button>
      </form>
    </Card>
  );
}
