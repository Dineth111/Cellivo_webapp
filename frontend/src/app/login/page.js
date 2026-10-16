'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { loginUser, saveSession } from '../../lib/api';
import styles from '../page.module.css';

/** Shop login. New accounts are created on /signup. */
export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '', remember: true });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      saveSession(await loginUser(form), form.remember);
      router.push('/');
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.authShell}>
      <section className={styles.authHero}>
        <span className={styles.badgeDark}>Mobile shop POS</span>
        <div>
          <h1>Run billing, IMEI stock and repairs from one dashboard.</h1>
          <p>Works on desktop, tablet and mobile. No IT setup needed.</p>
        </div>
      </section>
      <section className={styles.authPanel}>
        <form className={styles.authForm} onSubmit={submit}>
          <Link href="/" className={styles.logo}>CELLIVO</Link>
          <div>
            <h2>Welcome back</h2>
            <p className={styles.caption}>Log in to your shop account</p>
          </div>
          {error && <div className={styles.error} role="alert">{error}</div>}
          <label>Email<input type="email" value={form.email} onChange={set('email')} placeholder="you@shop.com" autoComplete="email" required /></label>
          <label>Password<input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required /></label>
          <label className={styles.checkbox}><input type="checkbox" checked={form.remember} onChange={set('remember')} />Remember this device</label>
          <button className={styles.primary} disabled={submitting}>{submitting ? 'Please wait…' : 'Log in'}</button>
          <p className={styles.switch}>New to Cellivo? <Link href="/signup">Start free trial</Link></p>
        </form>
      </section>
    </main>
  );
}
