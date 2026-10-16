'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { publicContact, publicDemo } from '../lib/api';
import PRICES from './pricing.json';

// The page bodies are cellivo.com's own pre-rendered HTML. This adds back what their React code did on top of it:
// scroll-in animations, pricing toggles, blog filter, contact form, demo booking and client-side navigation.

const FIELD = 'flex h-10 w-full rounded-md border bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm border-border';
const BTN = 'inline-flex items-center justify-center gap-2 whitespace-nowrap ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';
const TOPICS = [['enterprise', 'Enterprise pricing'], ['integration', 'Custom integration'], ['support', 'Technical support'], ['partnership', 'Partnership'], ['other', 'Other']];
const fmt = (n) => Number(n).toLocaleString('en-US');

function reveal(root) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.querySelectorAll('[style*="opacity"]').forEach((el) => { el.style.opacity = ''; el.style.transform = ''; });
    return () => {};
  }
  const targets = new Set([...root.querySelectorAll('main [style*="opacity:0"], main [style*="opacity: 0"], main section .grid > *')]);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const i = [...(el.parentElement?.children || [])].indexOf(el);
      el.style.transition = `opacity .45s ease ${Math.min(i, 10) * 60}ms, transform .45s ease ${Math.min(i, 10) * 60}ms`;
      el.style.opacity = '1';
      el.style.transform = 'none';
      io.unobserve(el);
    });
  }, { rootMargin: '0px 0px -60px 0px' });
  targets.forEach((el) => {
    if (getComputedStyle(el).display === 'contents') { el.style.opacity = ''; el.style.transform = ''; return; } // no box, never intersects
    if (!el.style.opacity) { el.style.opacity = '0'; el.style.transform = 'translateY(14px)'; }
    io.observe(el);
  });
  return () => io.disconnect();
}

function pricing(root) {
  const buttons = [...root.querySelectorAll('main button')];
  const cycleBtns = buttons.filter((b) => /^(Monthly|Yearly|Lifetime)/.test(b.textContent));
  const curBtns = buttons.filter((b) => /^(USD|LKR)$/.test(b.textContent.trim()));
  if (!cycleBtns.length) return;
  let cycle = 'monthly';
  let cur = 'LKR';
  const paint = () => {
    cycleBtns.forEach((b) => {
      const on = b.textContent.toLowerCase().startsWith(cycle);
      b.className = `relative px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-300 ${on ? 'text-white' : 'text-muted-foreground hover:text-foreground'}`;
      const pill = b.querySelector('div.absolute');
      if (on && !pill) b.insertAdjacentHTML('afterbegin', '<div class="absolute inset-0 rounded-full bg-foreground"></div>');
      if (!on && pill) pill.remove();
    });
    curBtns.forEach((b) => {
      b.className = `rounded-full px-4 py-2 text-sm font-medium transition-colors ${b.textContent.trim() === cur ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`;
    });
    root.querySelectorAll('main h3').forEach((h) => {
      const key = h.textContent.trim().toLowerCase();
      const plan = PRICES.find((p) => p.planKey === key && p.billingCycle === cycle);
      const card = h.closest('.rounded-2xl');
      const row = card?.querySelector('.items-baseline');
      if (!plan || !row || !plan.lkrPrice) return;
      const [code, amount, per] = row.querySelectorAll('span');
      code.textContent = cur;
      amount.textContent = fmt(cur === 'LKR' ? plan.lkrPrice : plan.usdPrice);
      if (per) per.textContent = cycle === 'monthly' ? '/mo' : cycle === 'yearly' ? '/yr' : '';
      row.parentElement.querySelector('p.cv-note')?.remove();
      if (cycle !== 'monthly') row.insertAdjacentHTML('afterend', `<p class="cv-note text-xs text-primary mt-1.5 font-medium">${cycle === 'yearly' ? 'Save 2 months — best annual deal' : 'Pay once, use forever'}</p>`);
      card.querySelectorAll('a[href^="/signup"]').forEach((a) => { a.href = `/signup?plan=${key}&term=${cycle}`; });
    });
  };
  const on = (list, fn) => list.forEach((b) => b.addEventListener('click', () => { fn(b); paint(); }));
  on(cycleBtns, (b) => { cycle = b.textContent.trim().toLowerCase().match(/^(monthly|yearly|lifetime)/)[1]; });
  on(curBtns, (b) => { cur = b.textContent.trim(); });
  paint();
}

function blogFilter(root) {
  const btns = [...root.querySelectorAll('main .flex-wrap > button')];
  if (!btns.length) return;
  btns.forEach((b) => b.addEventListener('click', () => {
    btns.forEach((x) => { x.className = `rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${x === b ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground'}`; });
    const want = b.textContent.trim();
    root.querySelectorAll('main article').forEach((a) => {
      a.style.display = want === 'All' || a.querySelector('span')?.textContent.trim() === want ? '' : 'none';
    });
  }));
}

function contactForm(root, toast) {
  const form = root.querySelector('main form');
  if (!form) return;
  const combo = form.querySelector('button[role="combobox"]');
  if (combo) {
    combo.outerHTML = `<select name="topic" required class="${FIELD}"><option value="">Select a topic</option>${TOPICS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await publicContact({
        name: f.fullName, email: f.email, phone: `${f.countryCode || ''} ${f.phoneNumber || ''}`.trim(), shopName: f.shopName,
        message: `[${f.topic || 'other'}] ${f.message || ''}`,
      });
      toast(res.message || "Thank you! We'll get back to you within 24 hours.");
      form.reset();
    } catch (err) {
      toast(err.message || 'We could not send your message right now.', true);
    } finally {
      btn.disabled = false;
    }
  });
}

export default function SiteEnhance() {
  const path = usePathname();
  const router = useRouter();
  const [toastMsg, setToastMsg] = useState(null);
  const [demo, setDemo] = useState(false);
  const toast = (text, error = false) => { setToastMsg({ text, error }); setTimeout(() => setToastMsg(null), 5000); };

  useEffect(() => {
    const root = document.querySelector('.cv');
    if (!root) return;
    const stop = reveal(root);
    pricing(root);
    blogFilter(root);
    contactForm(root, toast);
    const onClick = (e) => {
      const el = e.target.closest('a, button');
      if (!el || !root.contains(el) || el.closest('header')) return;
      if (/book (a |your )?(live )?demo/i.test(el.textContent)) { e.preventDefault(); setDemo(true); return; }
      const href = el.tagName === 'A' && el.getAttribute('href');
      if (href && href.startsWith('/') && !href.startsWith('/cellivo/') && !el.target && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        router.push(href);
      }
    };
    root.addEventListener('click', onClick);
    return () => { stop(); root.removeEventListener('click', onClick); };
  }, [path, router]);

  return (
    <>
      {demo && <DemoDialog onClose={() => setDemo(false)} toast={toast} />}
      {toastMsg && (
        <div role={toastMsg.error ? 'alert' : 'status'} className={`fixed bottom-6 right-6 z-[100] max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg ${toastMsg.error ? 'border-destructive/30 bg-white text-destructive' : 'border-border bg-white text-foreground'}`}>
          {toastMsg.text}
        </div>
      )}
    </>
  );
}

function DemoDialog({ onClose, toast }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const submit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const res = await publicDemo({ name: f.name, email: f.email, phone: f.phone, shopName: f.shopName, message: f.message, preferredAt: new Date(f.preferredAt).toISOString() });
      toast(res.message || 'Your demo request is booked.');
      onClose();
    } catch (err) {
      toast(err.message || 'Could not book the demo. Please call +94 70 272 0000.', true);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="demo-title" className="relative w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-lg">
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 text-xl leading-none">×</button>
        <h2 id="demo-title" className="text-lg font-heading font-semibold text-foreground">Book your live demo</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-5">Choose a time that works for you and we will walk you through Cellivo live.</p>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-sm font-medium text-foreground block">Full Name *<input name="name" required className={`${FIELD} mt-2`} placeholder="Your name" /></label>
            <label className="text-sm font-medium text-foreground block">Email *<input name="email" type="email" required className={`${FIELD} mt-2`} placeholder="you@company.com" /></label>
            <label className="text-sm font-medium text-foreground block">Phone *<input name="phone" type="tel" required className={`${FIELD} mt-2`} placeholder="+94 77 123 4567" /></label>
            <label className="text-sm font-medium text-foreground block">Shop Name<input name="shopName" className={`${FIELD} mt-2`} placeholder="Your shop name" /></label>
          </div>
          <label className="text-sm font-medium text-foreground block">Preferred date &amp; time *<input name="preferredAt" type="datetime-local" required className={`${FIELD} mt-2`} /></label>
          <label className="text-sm font-medium text-foreground block">Message<textarea name="message" rows={3} className={`${FIELD} mt-2 h-auto`} placeholder="Anything we should know?" /></label>
          <button disabled={busy} className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90 font-medium px-8 h-12 w-full rounded-xl`}>{busy ? 'Booking…' : 'Book Demo →'}</button>
        </form>
      </div>
    </div>
  );
}
