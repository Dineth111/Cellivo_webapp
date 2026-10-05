'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  cancelSubscription, downloadInvoice, getBillingPlans, getBillingSummary, getInvoices, hasSession, markNoticesRead,
  quotePlan, subscribePlan, undoCancel,
} from '../../lib/api';
import { Alert, AppHeader, Button, Card, Field, Hero, Spinner, Stat, StatGrid, Table, User, Welcome, date, money, price } from '../../components/ui';

// Hero buttons are white or glass: the shared Button's heroBtn / onDark variants
const HeroButton = ({ ghost, ...p }) => <Button variant={ghost ? 'onDark' : 'heroBtn'} {...p} />;

/** F-20 portal home plus F-02 plan picker, payment and invoices. Owner only (the API returns 403 otherwise). */
export default function Billing() {
  const [summary, setSummary] = useState(null);
  const [plans, setPlans] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  const load = useCallback(
    () => Promise.all([getBillingSummary(), getBillingPlans(), getInvoices()])
      .then(([s, p, i]) => { setSummary(s.data); setPlans(p.data); setInvoices(i.data); })
      .catch((err) => setError(err.message)),
    []
  );

  useEffect(() => {
    // no session: show the "log in" message without calling the API
    Promise.resolve(hasSession() && load()).then(() => setLoaded(true));
  }, [load]);

  if (!loaded) return <Shell><Spinner /></Shell>;
  if (!summary) return <Shell>{error ? <Alert tone="danger">{error}</Alert> : <Alert>Please <Link href="/">log in</Link> to see billing.</Alert>}</Shell>;

  const { plan, state } = summary;
  const act = async (fn, done) => {
    setError(''); setMsg('');
    try {
      const r = await fn();
      setMsg(done ?? r?.message ?? '');
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Shell user={summary.ownerName}>
      {error &&<Alert tone="danger">{error}</Alert>}
      {msg && <Alert tone="success">{msg}</Alert>}
      {state === 'suspended' && <Alert tone="danger">Your shop is read-only until the subscription is paid. You can still pay and export your data here.</Alert>}
      {state === 'past_due' && <Alert tone="warning">Your last payment failed. Update your card; we retry automatically{summary.nextRetry ? ` (next try ${date(summary.nextRetry)})` : ''}.</Alert>}
      {summary.notices.length > 0 && (
        <Alert tone="warning">
          {summary.notices.map((n) => <div key={n.id}>{n.message}</div>)}
          <Button variant="secondary" onClick={() => act(markNoticesRead, '')}>Dismiss</Button>
        </Alert>
      )}

      <Welcome name={summary.ownerName} />

      <Hero
        badges={[[HERO_BADGE[state]], ...(summary.renewsAt ? [[`${summary.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${date(summary.renewsAt)}`, true]] : [])]}
        title={heroTitle(summary)}
        subtitle={plan.chosen && plan.price !== null ? `${price(plan.price, plan.currency)} / ${plan.term.replace('ly', '')}${summary.renewsAt && !summary.cancelAtPeriodEnd && state === 'active' ? ` · Auto-renews ${date(summary.renewsAt)}` : ''}` : undefined}
        actions={<>
          <HeroButton onClick={() => router.push('/')}>Open my shop</HeroButton>
          <HeroButton ghost onClick={() => document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' })}>{state === 'active' ? 'Upgrade plan' : 'Choose a plan'}</HeroButton>
        </>}
        aside={[
          { label: 'Billing setup', value: summary.setup.label, bar: summary.setup.percent, wide: true },
          { label: 'Billing term', value: plan.term[0].toUpperCase() + plan.term.slice(1), helper: summary.renewsAt ? `Next charge ${date(summary.renewsAt)}` : plan.chosen ? 'No renewal' : 'Not started' },
          { label: 'Branch access', value: `${summary.branches.used} of ${summary.branches.limit ?? '∞'} branches`, helper: plan.chosen ? `Included with ${plan.name}` : 'Free trial limits' },
        ]}
      >
        {state === 'trial' && `You are on a free trial of ${plan.name}: ${summary.trialDaysLeft} day(s) left. Add a card before it ends to keep your shop running.`}
        {state === 'active' && 'Your shop workspace is live. Manage renewals, branch scaling and your plan from this portal.'}
        {summary.pendingPlanCode && ` Changing to ${summary.pendingPlanCode} at the next renewal.`}
      </Hero>

      <StatGrid>
        <Stat label="Lifetime spend" value={money(summary.stats.lifetimeSpend, plan.currency)} helper="Across all paid orders" />
        <Stat label="Current billing" value={summary.status.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())} helper={summary.paymentMethod ? `${summary.paymentMethod.brand} ending ${summary.paymentMethod.last4}` : 'No card saved'} />
        <Stat label="Active plans" value={summary.stats.activePlans} helper={summary.stats.activePlans ? 'Subscription in progress' : 'None yet'} />
        <Stat label="Member since" value={new Date(summary.stats.memberSince).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} helper={`${summary.stats.invoiceCount} invoice(s)`} />
      </StatGrid>

      <Card title="Choose a plan" id="plans">
        <Picker plans={plans} current={summary} onDone={(m) => { setMsg(m); load(); }} onError={setError} />
      </Card>

      {summary.status === 'active' && (
        <Card title="Cancel subscription">
          {summary.cancelAtPeriodEnd ? (
            <>
              <span>Your subscription ends {date(summary.renewsAt)}.</span>
              <Button variant="secondary" onClick={() => act(undoCancel)}>Keep my subscription</Button>
            </>
          ) : (
            <>
              <span>You keep access until the paid period ends, then your shop is read-only for {summary.readOnlyDays} days.</span>
              <Button variant="danger" onClick={() => window.confirm('Cancel your subscription at the end of the period?') && act(cancelSubscription)}>Cancel subscription</Button>
            </>
          )}
        </Card>
      )}

      <Card title="Invoices">
        {invoices.length === 0 ? <span>No invoices yet.</span> : (
          <Table head={['Number', 'Date', 'Plan', 'Total', 'Status', '']}>
            {invoices.map((i) => (
              <tr key={i._id}>
                <td>{i.number}</td>
                <td>{date(i.paidAt)}</td>
                <td>{i.planCode} ({i.term})</td>
                <td>{money(i.total, i.currency)}</td>
                <td>{i.status.replace('_', ' ')}</td>
                <td><Button variant="secondary" onClick={() => act(() => downloadInvoice(i), '')}>PDF</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}

function Picker({ plans, current, onDone, onError }) {
  const [planCode, setPlanCode] = useState(current.plan.chosen ? current.plan.code : 'starter');
  const [term, setTerm] = useState(current.plan.term || 'monthly');
  const [currency, setCurrency] = useState(current.plan.currency || 'LKR');
  const [couponCode, setCouponCode] = useState('');
  const [card, setCard] = useState('');
  const [fetched, setFetched] = useState(null); // { key, data } so a stale quote is never shown for other choices
  const [busy, setBusy] = useState(false);
  const chosen = plans.find((p) => p.code === planCode);
  const body = { planCode, term, currency, couponCode: couponCode || undefined };
  const key = [planCode, term, currency, couponCode].join('|');
  const same = current.status === 'active' && planCode === current.plan.code && term === current.plan.term; // the API would answer 409
  const quote = fetched?.key === key ? fetched.data : null;

  useEffect(() => {
    let live = true;
    if (same || !chosen || chosen.contactSales || !chosen.prices?.[term]) return undefined;
    quotePlan({ planCode, term, currency, couponCode: couponCode || undefined })
      .then((r) => { if (live) { onError(''); setFetched({ key, data: r.data }); } })
      .catch((e) => { if (live) onError(e.message); });
    return () => { live = false; };
  }, [key, same, planCode, term, currency, couponCode, chosen, onError]);

  const buy = async (e) => {
    e.preventDefault();
    setBusy(true);
    onError('');
    try {
      const r = await subscribePlan({ ...body, card: card ? { number: card } : undefined });
      onDone(r.message);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (chosen?.contactSales) return <Alert>The {chosen.name} plan is arranged with our sales team. Please contact sales.</Alert>;
  return (
    <form onSubmit={buy} style={{ display: 'grid', gap: 14 }}>
      <Field label="Plan" as="select" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
        {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
      </Field>
      <Field label="Billing" as="select" value={term} onChange={(e) => setTerm(e.target.value)}>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
        <option value="lifetime">Lifetime</option>
      </Field>
      {current.status !== 'active' && (
        <Field label="Currency" as="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="LKR">LKR</option>
          <option value="USD">USD</option>
        </Field>
      )}
      <Field label="Coupon (optional)" value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())} />
      <Field
        label="Card number" inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value)} autoComplete="cc-number"
        hint={current.paymentMethod ? 'Leave empty to use your saved card' : undefined} required={!current.paymentMethod}
      />
      {same && <Alert>This is your current plan. Pick another plan or billing term to change it.</Alert>}
      {quote && (
        <Alert>
          {quote.kind === 'downgrade' ? 'Takes effect at your next renewal. Nothing to pay today.' : (
            <>
              <div>
                Price {money(quote.price, quote.currency)}
                {quote.discount ? `, discount -${money(quote.discount, quote.currency)}` : ''}
                {quote.credit ? `, credit -${money(quote.credit, quote.currency)}` : ''}
                {quote.tax ? `, tax ${money(quote.tax, quote.currency)}` : ''}
              </div>
              <strong>Due today: {money(quote.total, quote.currency)}</strong>
            </>
          )}
        </Alert>
      )}
      <Button disabled={busy || !quote} style={{ justifySelf: 'stretch', padding: '12px 20px' }}>{busy ? 'Please wait…' : quote?.kind === 'downgrade' ? 'Schedule change' : 'Pay and activate'}</Button>
    </form>
  );
}

function Shell({ children, user }) {
  return (
    <>
      <AppHeader chip="Account portal">
        <Link href="/" style={{ fontWeight: 600 }}>Back to dashboard</Link>
        {user && <User name={user} />}
      </AppHeader>
      <main style={{ maxWidth: 1070, margin: '0 auto', padding: '24px 16px 48px', display: 'grid', gap: 18 }}>{children}</main>
    </>
  );
}

const HERO_BADGE = { new: 'Get started', trial: 'Free trial', active: 'Subscription active', past_due: 'Payment failed', suspended: 'Suspended' };
function heroTitle(s) {
  const { plan, state } = s;
  if (state === 'new') return 'Choose a plan to get started';
  if (state === 'trial') return `${plan.name} free trial`;
  if (state === 'active') return `${plan.name} plan is active`;
  if (state === 'past_due') return 'Your last payment failed';
  return 'Your shop is suspended';
}
