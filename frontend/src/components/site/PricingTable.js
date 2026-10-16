'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './site.module.css';

// Monthly USD prices from cellivo.com. Yearly = 10 x monthly ("save 2 months"). Lifetime price is set at signup.
const PLANS = [
  { code: 'lite', name: 'Lite', usd: 10, branches: '1 branch', blurb: 'Simple retail shops', imei: false },
  { code: 'starter', name: 'Starter', usd: 25, branches: '1 branch', blurb: 'Single-location phone shops', imei: true },
  { code: 'growth', name: 'Growth', usd: 40, branches: 'Up to 3 branches', blurb: 'Growing multi-branch shops', imei: true, popular: true },
  { code: 'business', name: 'Business', usd: 55, branches: 'Up to 6 branches', blurb: 'Established multi-location retailers', imei: true },
  { code: 'unlimited', name: 'Unlimited', branches: 'Unlimited branches', blurb: 'Franchises and large operations', imei: true },
];
const TERMS = [['monthly', 'Monthly'], ['yearly', 'Yearly (save 2 months)'], ['lifetime', 'Lifetime']];

function priceLine(p, term) {
  if (!p.usd) return ['Contact us', ''];
  if (term === 'monthly') return [`$${p.usd}`, '/month'];
  if (term === 'yearly') return [`$${p.usd * 10}`, '/year'];
  return ['One-time', 'best value'];
}

export default function PricingTable() {
  const [term, setTerm] = useState('monthly');
  return (
    <>
      <div style={{ textAlign: 'center' }}>
        <div className={styles.terms} role="group" aria-label="Billing term">
          {TERMS.map(([t, label]) => (
            <button key={t} type="button" aria-pressed={term === t} onClick={() => setTerm(t)}>{label}</button>
          ))}
        </div>
      </div>
      <div className={styles.plans}>
        {PLANS.map((p) => {
          const [amount, per] = priceLine(p, term);
          return (
            <article key={p.code} className={`${styles.plan} ${p.popular ? styles.popular : ''}`}>
              {p.popular && <span className={styles.popTag}>Most Popular</span>}
              <h3>{p.name}</h3>
              <p>{p.blurb}</p>
              <div className={styles.price}>{amount} <small>{per}</small></div>
              <ul>
                <li>{p.branches}</li>
                <li>Billing, inventory &amp; customers</li>
                <li>Suppliers &amp; purchasing</li>
                <li>{p.code === 'lite' ? 'Basic reports' : 'Advanced reports & analytics'}</li>
                <li className={p.imei ? '' : styles.no}>IMEI stock control</li>
                <li className={p.imei ? '' : styles.no}>Repair job management</li>
                <li className={p.imei ? '' : styles.no}>Priority support</li>
              </ul>
              {p.usd ? (
                <Link className={p.popular ? styles.btn : styles.btnGhost} href={`/signup?plan=${p.code}&term=${term}`}>Start free trial</Link>
              ) : (
                <Link className={styles.btnGhost} href="/contact">Contact sales</Link>
              )}
            </article>
          );
        })}
      </div>
      <p className={styles.note}>No credit card to start · Cancel anytime · Prices in USD (LKR available at signup)</p>
    </>
  );
}
