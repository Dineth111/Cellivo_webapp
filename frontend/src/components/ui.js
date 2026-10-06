import styles from './ui.module.css';

const cx = (...c) => c.filter(Boolean).join(' ');

// variant: secondary | danger | heroBtn | onDark (the last two are for use on the dark Hero)
export const Button = ({ variant, className, ...p }) => (
  <button className={cx(styles.btn, variant && styles[variant], className)} {...p} />
);

/** Label + input (or select/textarea, via `as`) with a hint and an error message wired for screen readers. */
export function Field({ label, hint, error, as: As = 'input', children, ...p }) {
  return (
    <label className={styles.field}>
      {label}
      <As aria-invalid={error ? 'true' : undefined} {...p}>{children}</As>
      {error ? <span className={styles.err} role="alert">{error}</span> : hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}

export const Card = ({ title, children, className, ...rest }) => (
  <article className={cx(styles.card, className)} {...rest}>
    {title && <h3>{title}</h3>}
    {children}
  </article>
);

// tone: neutral | success | warning | danger
const BADGE = { success: styles.success, warning: styles.warning, danger: styles.dangerBadge };
export const Badge = ({ tone, children }) => <span className={cx(styles.badge, BADGE[tone])}>{children}</span>;

const ALERT = { success: styles.alertSuccess, warning: styles.alertWarning, danger: styles.alertDanger };
export const Alert = ({ tone, children }) => (
  <div className={cx(styles.alert, ALERT[tone])} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div>
);

/** Top bar: logo, a section chip and whatever goes on the right (user, links). */
export const AppHeader = ({ chip, children }) => (
  <header className={styles.header}>
    <div className={styles.brand}>
      <span className={styles.mark}>C</span>
      <span className={styles.wordmark}>CELLIVO</span>
      {chip && <span className={styles.chip}>{chip}</span>}
    </div>
    <div className={styles.right}>{children}</div>
  </header>
);

export const Chip = ({ ok, children }) => <span className={cx(styles.chip, ok && styles.chipOk)}>{children}</span>;
export const Avatar = ({ name = '?' }) => <span className={styles.avatar} aria-hidden="true">{name.trim()[0]?.toUpperCase()}</span>;
export const User = ({ name }) => <span className={styles.user}><Avatar name={name} />{name}</span>;
export const Welcome = ({ name }) => (
  <div className={styles.welcome}>
    <Avatar name={name} />
    <div><small>Welcome back,</small><strong>{name}</strong></div>
  </div>
);
export const Eyebrow =({ children }) => <span className={styles.eyebrow}>{children}</span>;

/** Dark gradient banner. badges: [[text, ghost?]]. aside: tiles { label, value, helper?, wide?, bar? (0-100) }. */
export const Hero = ({ badges = [], title, subtitle, children, actions, aside = [] }) => (
  <section className={styles.hero}>
    <div>
      <div className={styles.heroBadges}>
        {badges.map(([t, ghost]) => <span key={t} className={cx(styles.heroChip, ghost && styles.heroChipGhost)}>{t}</span>)}
      </div>
      <h2>{title}</h2>
      {subtitle && <p><strong style={{ color: '#fff' }}>{subtitle}</strong></p>}
      {children && <p style={{ marginTop: 12 }}>{children}</p>}
      {actions && <div className={styles.heroActions}>{actions}</div>}
    </div>
    <div className={styles.heroAside}>
      {aside.map((a) => (
        <div key={a.label} className={cx(styles.glass, a.wide && styles.glassWide)}>
          <span className={styles.glassLabel}>{a.label}</span>
          <strong>{a.value}</strong>
          {a.bar !== undefined && <div className={styles.bar}><span style={{ width: `${a.bar}%` }} /></div>}
          {a.helper && <small>{a.helper}</small>}
        </div>
      ))}
    </div>
  </section>
);

export const Stat = ({ label, value, helper, up }) => (
  <Card className={styles.stat}>
    <span className={styles.statLabel}>{label}</span>
    <span className={styles.statValue}>{value}</span>
    {helper && <span className={cx(styles.statHelper, up && styles.statUp)}>{helper}</span>}
  </Card>
);
export const StatGrid = ({ children }) => <section className={styles.statGrid}>{children}</section>;

export const Spinner = () => <span className={styles.spinner} role="status" aria-label="Loading" />;

export const Table = ({ head, children }) => (
  <div className={styles.scroll}>
    <table className={styles.table}>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/** Money from minor units (cents) in the given currency. */
export const money = (minor, currency = 'LKR') =>
  `${currency === 'LKR' ? 'Rs' : '$'} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
/** Plan prices are in major units. */
export const price = (major, currency = 'LKR') => money(Math.round(major * 100), currency);
export const date = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
