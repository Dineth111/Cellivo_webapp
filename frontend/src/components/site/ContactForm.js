'use client';

import { useState } from 'react';
import styles from './site.module.css';

const TOPICS = ['Book a live demo', 'Pricing / Unlimited plan', 'Technical support', 'Other'];

// No public contact API exists yet: the form opens the visitor's email app addressed to hello@cellivo.com.
export default function ContactForm() {
  const [sent, setSent] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const body = `Name: ${f.name}\nEmail: ${f.email}\nPhone: ${f.phone}\nShop: ${f.shop || '-'}\n\n${f.message}`;
    window.location.href = `mailto:hello@cellivo.com?subject=${encodeURIComponent(f.topic)}&body=${encodeURIComponent(body)}`;
    setSent(true);
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <label>Full name<input name="name" required autoComplete="name" /></label>
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <label>Phone<input name="phone" type="tel" required placeholder="+94 77 123 4567" autoComplete="tel" /></label>
      <label>Shop name (optional)<input name="shop" /></label>
      <label>Topic
        <select name="topic" required defaultValue="">
          <option value="" disabled>Select a topic</option>
          {TOPICS.map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <label>Message<textarea name="message" required /></label>
      <button className={styles.btn}>Send Message</button>
      {sent && <p className={styles.ok} role="status">Your email app should open with the message ready to send.</p>}
    </form>
  );
}
