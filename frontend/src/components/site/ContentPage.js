import Link from 'next/link';
import SiteShell from './SiteShell';
import { CtaBand } from './HomePage';
import { FEATURE_LINKS } from './links';
import styles from './site.module.css';

/** Renders a page from siteContent.js: kind 'landing' (feature / industry pages), 'legal' or 'post'. */
export default function ContentPage({ slug, page, active }) {
  if (page.kind === 'landing') return <Landing slug={slug} page={page} />;
  return (
    <SiteShell active={active}>
      <article className={`${styles.section} ${styles.article}`} style={{ paddingTop: 128 }}>
        <div className={styles.prose}>
          {page.kind === 'post' && <Link href="/blog" className={styles.textLinkP}>← All articles</Link>}
          <h1>{page.h1}</h1>
          {page.excerpt && <p className={styles.lead}>{page.excerpt}</p>}
          <Body blocks={page.body} />
          {page.faq?.length > 0 && <><h2>Frequently Asked Questions</h2><Faq items={page.faq} /></>}
        </div>
      </article>
      {page.kind === 'post' && <CtaBand />}
    </SiteShell>
  );
}

function Body({ blocks }) {
  return blocks.map(([t, x], i) => {
    if (t === 'ul') return <ul key={i}>{x.map((li) => <li key={li}>{li}</li>)}</ul>;
    if (t === 'h2') return <h2 key={i}>{x}</h2>;
    if (t === 'h3' || t === 'h4') return <h3 key={i}>{x}</h3>;
    return <p key={i}>{x}</p>;
  });
}

const Faq = ({ items }) => (
  <div className={styles.faq}>
    {items.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
  </div>
);

function Landing({ slug, page }) {
  const more = FEATURE_LINKS.filter(([href]) => href !== `/${slug}`).slice(0, 6);
  return (
    <SiteShell active={`/${slug}`}>
      <section className={styles.hero}>
        <div className={styles.wrap} style={{ maxWidth: 960, textAlign: 'center' }}>
          {page.kicker.length > 0 && (
            <ul className={styles.kicker}>{page.kicker.map((k) => <li key={k}>{k}</li>)}</ul>
          )}
          <h1>{page.h1}</h1>
          <p style={{ marginInline: 'auto' }}>{page.sub}</p>
          <div className={styles.ctaRow} style={{ justifyContent: 'center' }}>
            <Link href={slug === 'affiliate' ? '/contact?topic=affiliate' : '/pricing'} className={styles.btn}>
              {slug === 'affiliate' ? 'Apply to Join' : 'Start Free Trial'}
            </Link>
            <Link href="/contact?topic=demo" className={styles.btnGhost}>Book a Demo</Link>
          </div>
          {page.note && <p className={styles.small}>{page.note}</p>}
          {page.stats.length > 0 && (
            <div className={styles.statRow}>
              {page.stats.map(([v, l]) => <div key={l}><strong>{v}</strong><span>{l}</span></div>)}
            </div>
          )}
        </div>
      </section>

      {page.sections.map((s, i) => (
        <section key={i} className={`${styles.section} ${i % 2 ? '' : styles.alt}`}>
          <div className={styles.wrap}>
            {(s.h2 || s.paras.length > 0) && (
              <div className={styles.head}>
                {s.h2 && <h2>{s.h2}</h2>}
                {s.paras.map((p) => <p key={p}>{p}</p>)}
              </div>
            )}
            {s.cards.length > 0 && (
              <div className={styles.grid}>
                {s.cards.map(([t, d]) => <article key={t} className={styles.card}><h3>{t}</h3><p>{d}</p></article>)}
              </div>
            )}
            {s.list.length > 0 && <ul className={styles.checks} style={{ maxWidth: 720, marginInline: 'auto' }}>{s.list.map((l) => <li key={l}>{l}</li>)}</ul>}
          </div>
        </section>
      ))}

      {page.faq.length > 0 && (
        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.head}><span className={styles.eyebrow}>FAQ</span><h2>Common Questions</h2></div>
            <Faq items={page.faq} />
          </div>
        </section>
      )}

      {slug !== 'affiliate' && (
        <section className={`${styles.section} ${styles.alt}`}>
          <div className={styles.wrap}>
            <div className={styles.head}><h2>More Features for Your Phone Shop</h2></div>
            <div className={styles.grid}>
              {more.map(([href, t, d]) => (
                <Link key={href} href={href} className={`${styles.card} ${styles.cardLink}`}><h3>{t} →</h3><p>{d}</p></Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <CtaBand title={page.cta?.h2} text={page.cta?.p} />
    </SiteShell>
  );
}
