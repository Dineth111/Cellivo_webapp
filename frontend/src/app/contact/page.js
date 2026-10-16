import SiteShell from '../../components/site/SiteShell';
import ContactForm from '../../components/site/ContactForm';
import styles from '../../components/site/site.module.css';

export const metadata = { title: 'Contact | Cellivo', description: 'Talk to the Cellivo team or book a live demo.' };

export default function ContactPage() {
  return (
    <SiteShell active="/contact">
      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.head}>
            <span className={styles.eyebrow}>Contact</span>
            <h2>Talk to the Cellivo team</h2>
            <p>Book a live demo or ask us anything about running your phone shop on Cellivo.</p>
          </div>
          <div className={styles.contactGrid}>
            <ul className={`${styles.card} ${styles.info}`}>
              <li><small>Phone</small><a href="tel:+94702720000">+94 70 272 0000</a></li>
              <li><small>Email</small><a href="mailto:hello@cellivo.com">hello@cellivo.com</a></li>
              <li><small>Address</small>318/A/3 High Level Rd, Pannipitiya 10230, Sri Lanka</li>
              <li><small>Support</small><a href="https://support.cellivo.com" target="_blank" rel="noreferrer">support.cellivo.com</a></li>
            </ul>
            <div className={styles.card}><ContactForm /></div>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
