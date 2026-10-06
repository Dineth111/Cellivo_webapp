'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { publicPlans, saveSession, signupCheckCode, signupResend, signupStart, signupVerify } from '../../lib/api';
import { Alert, AppHeader, Button, Card, Chip, Field, price } from '../../components/ui';

const COUNTRIES = [['LK', 'Sri Lanka (LKR)'], ['IN', 'India'], ['MV', 'Maldives'], ['BD', 'Bangladesh'], ['PK', 'Pakistan'], ['AE', 'United Arab Emirates']];
const TERMS = [['monthly', 'Monthly'], ['yearly', 'Yearly'], ['lifetime', 'Lifetime']];
const grid = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' };
const wide = { gridColumn: '1 / -1' };

/** F-01 sign-up: details -> 6-digit email code -> trial starts. No payment details are asked for. */
export default function SignupPage() {
  return (
    <Suspense>
      <Signup />
    </Suspense>
  );
}

function Signup() {
  const router = useRouter();
  const query = useSearchParams(); // the pricing page links here with ?plan=growth&term=yearly
  const [plans, setPlans] = useState([]);
  const [step, setStep] = useState('form');
  const [form, setForm] = useState({ name: '', shopName: '', email: '', phone: '', country: 'LK', password: '', planCode: query.get('plan') || 'starter', term: query.get('term') || 'monthly', code: '', acceptTerms: false });
  const [codeInfo, setCodeInfo] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  useEffect(() => { publicPlans().then(setPlans).catch(() => {}); }, []);

  const run = async (fn) => {
    setError(''); setNotice(''); setBusy(true);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const checkCode = () => form.code && run(async () => {
    const { data } = await signupCheckCode(form.code);
    setCodeInfo(data.kind === 'coupon' ? 'Coupon accepted. It is used when you buy a plan.' : 'Affiliate code accepted.');
  });

  const start = (e) => { e.preventDefault(); run(async () => { await signupStart(form); setStep('code'); }); };
  const verify = (e) => {
    e.preventDefault();
    run(async () => {
      const res = await signupVerify(form.email, otp);
      saveSession(res, true);
      router.push('/billing');
    });
  };
  const resend = () => run(async () => { await signupResend(form.email); setNotice('A new code was sent.'); });

  const chosen = plans.find((p) => p.code === form.planCode);
  const selectable = plans.filter((p) => p.prices?.[form.term] && (p.prices[form.term].LKR || p.prices[form.term].USD));
  const termName = TERMS.find(([t]) => t === form.term)?.[1];

  return (
    <>
      <AppHeader><Link href="/" style={{ fontWeight: 600 }}>Log in</Link></AppHeader>
      <main style={{ maxWidth: 560, margin: '0 auto', padding: '32px 16px 56px', display: 'grid', gap: 16 }}>
        <Card>
          <div style={{ textAlign: 'center', display: 'grid', gap: 8, justifyItems: 'center', marginBottom: 6 }}>
            <Chip>{chosen ? `${chosen.trialDays}-day free trial` : 'Free trial'}</Chip>
            <h1 style={{ color: 'var(--heading)', fontSize: 30, letterSpacing: -0.5 }}>
              {step === 'form' ? 'Create your Cellivo account' : 'Check your email'}
            </h1>
            <p style={{ color: 'var(--secondary)' }}>
              {step === 'form' ? 'No credit card required · Instant access · Cancel anytime' : <>We sent a 6-digit code to <strong>{form.email}</strong>. It is valid for 15 minutes.</>}
            </p>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}

          {step === 'form' ? (
            <form onSubmit={start} style={{ display: 'grid', gap: 16 }}>
              <div style={{ ...grid, gridTemplateColumns: '1fr auto', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: '12px 16px' }}>
                <div>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: 'var(--label)' }}>SELECTED PLAN</span>
                  <div style={{ fontWeight: 700, color: 'var(--heading)' }}>
                    {chosen?.name ?? form.planCode} Plan · {termName}{chosen ? ` · ${price(chosen.prices[form.term]?.LKR ?? 0)}` : ''}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <select aria-label="Plan" value={form.planCode} onChange={set('planCode')} style={{ borderRadius: 999, padding: '6px 12px', border: '1px solid var(--input-border)', background: 'var(--tint)', color: 'var(--brand)', fontWeight: 600 }}>
                    {(selectable.length ? selectable : [{ code: form.planCode, name: form.planCode }]).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                  </select>
                  <select aria-label="Billing" value={form.term} onChange={set('term')} style={{ borderRadius: 999, padding: '6px 12px', border: '1px solid var(--input-border)', background: 'var(--surface)', color: 'var(--body)' }}>
                    {TERMS.map(([t, n]) => <option key={t} value={t}>{n}</option>)}
                  </select>
                </div>
              </div>

              <div style={grid}>
                <Field label="Full name *" value={form.name} onChange={set('name')} placeholder="e.g. Nimal Perera" required />
                <Field label="Shop name *" value={form.shopName} onChange={set('shopName')} placeholder="e.g. Nimal Mobile" hint="Becomes your workspace display name" required />
                <Field label="Email address *" type="email" value={form.email} onChange={set('email')} placeholder="nimal@shop.lk" autoComplete="email" required />
                <Field label="Mobile number (E.164) *" type="tel" value={form.phone} onChange={set('phone')} placeholder="+94771234567" hint="Include country code (+94...)" required />
                <Field label="Country *" as="select" value={form.country} onChange={set('country')}>
                  {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                </Field>
                <Field label="Password *" type="password" value={form.password} onChange={set('password')} placeholder="Min 8 chars, 1 letter, 1 number" autoComplete="new-password" minLength={8} required />
                <div style={wide}>
                  <Field label="Affiliate or coupon code (optional)" value={form.code} onChange={set('code')} onBlur={checkCode} placeholder="e.g. TECHLK or WELCOME20" hint={codeInfo || undefined} />
                </div>
              </div>

              <label style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
                <input type="checkbox" checked={form.acceptTerms} onChange={set('acceptTerms')} required />
                <span>I agree to the <strong>Terms of Service</strong> and <strong>Privacy Policy</strong></span>
              </label>
              <Button disabled={busy} style={{ padding: '14px 20px', fontSize: 15, justifySelf: 'stretch' }}>{busy ? 'Please wait…' : 'Create Account & Start Free Trial →'}</Button>
              <p style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap', color: 'var(--secondary)', fontSize: 13, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <span>✓ No credit card needed</span>
                <span>✓ Set up in under a minute</span>
              </p>
            </form>
          ) : (
            <>
              <form onSubmit={verify} style={{ display: 'grid', gap: 16 }}>
                <Field label="Verification code" value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
                <Button disabled={busy} style={{ justifySelf: 'stretch' }}>{busy ? 'Please wait…' : 'Verify and start my trial'}</Button>
              </form>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Button variant="secondary" type="button" onClick={resend} disabled={busy}>Send a new code</Button>
                <Button variant="secondary" type="button" onClick={() => setStep('form')}>Change my details</Button>
              </div>
            </>
          )}
        </Card>
      </main>
    </>
  );
}
