'use client';

import { useEffect, useState } from 'react';
import { publicContact, publicDemo } from '../../lib/api';
import styles from './site.module.css';

const TOPICS = ['Sales question', 'Pricing / Unlimited plan', 'Affiliate program', 'Technical support', 'Other'];

/** Contact (POST /api/public/contact) and Book a demo (POST /api/public/demo). Both save a Lead for the sales team. */
export default function ContactForm() {
  const [mode, setMode] = useState('contact');
  const [state, setState] = useState({ busy: false, ok: '', err: '' });

  useEffect(() => {
    const topic = new URLSearchParams(window.location.search).get('topic');
    if (topic === 'demo') setMode('demo');
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    setState({ busy: true, ok: '', err: '' });
    try {
      const body = { name: f.name, email: f.email, phone: f.phone, shopName: f.shop, website: f.website };
      const res = mode === 'demo'
        ? await publicDemo({ ...body, preferredAt: new Date(f.preferredAt).toISOString(), message: f.message })
        : await publicContact({ ...body, message: `[${f.topic}] ${f.message}` });
      setState({ busy: false, ok: res.message || 'Thanks! We will get back to you shortly.', err: '' });
      form.reset();
    } catch (err) {
      setState({ busy: false, ok: '', err: err.message || 'Could not send. Please call +94 70 272 0000.' });
    }
  };

  return (
    <>
      <div className={styles.tabs} role="group" aria-label="Request type">
        <button type="button" aria-pressed={mode === 'contact'} onClick={() => setMode('contact')}>Send a message</button>
        <button type="button" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>Book a live demo</button>
      </div>
      <form className={styles.form} onSubmit={submit}>
        <label>Full name<input name="name" required autoComplete="name" /></label>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Phone<input name="phone" type="tel" required placeholder="+94 77 123 4567" autoComplete="tel" /></label>
        <label>Shop name (optional)<input name="shop" /></label>
        {mode === 'demo' ? (
          <label>Preferred date &amp; time<input name="preferredAt" type="datetime-local" required /></label>
        ) : (
          <label>Topic
            <select name="topic" required defaultValue="">
              <option value="" disabled>Select a topic</option>
              {TOPICS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        )}
        <label>Message{mode === 'demo' && ' (optional)'}<textarea name="message" required={mode === 'contact'} /></label>
        <input name="website" className={styles.hp} tabIndex={-1} autoComplete="off" aria-hidden="true" />
        <button className={styles.btn} disabled={state.busy}>{state.busy ? 'Sending…' : mode === 'demo' ? 'Book Demo' : 'Send Message'}</button>
        {state.ok && <p className={styles.ok} role="status">{state.ok}</p>}
        {state.err && <p className={styles.err} role="alert">{state.err}</p>}
      </form>
    </>
  );
}
