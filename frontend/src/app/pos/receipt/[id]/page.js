'use client';

import { use, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Spinner, Alert } from '../../../../components/ui';
import ReceiptPrint from '../../../../components/pos/ReceiptPrint';
import { getInvoiceById } from '../../../../lib/posApi';
import styles from './receipt.module.css';

const TEMPLATES = [
  { id: 'thermal-58', label: '58 mm Slip' },
  { id: 'thermal-80', label: '80 mm Standard' },
  { id: 'a4', label: 'A4 Tax Invoice' },
  { id: 'a5', label: 'A5 Counter Bill' },
];

export default function ReceiptPage({ params }) {
  const unwrappedParams = use(params);
  const invoiceId = unwrappedParams.id;
  const searchParams = useSearchParams();
  const autoprint = searchParams.get('autoprint') === 'true';

  const [invoice, setInvoice] = useState(null);
  const [template, setTemplate] = useState('thermal-80');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isReprint, setIsReprint] = useState(false);

  useEffect(() => {
    let ignore = false;
    if (!invoiceId) return;

    getInvoiceById(invoiceId)
      .then((data) => {
        if (!ignore) {
          setInvoice(data);
          const isFresh = searchParams.get('fresh') === 'true';
          setIsReprint(!isFresh);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!ignore) {
          setError(err.message || 'Failed to load invoice for printing.');
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [invoiceId, searchParams]);

  // Autoprint trigger
  useEffect(() => {
    if (!loading && invoice && autoprint) {
      const timer = setTimeout(() => {
        window.print();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [loading, invoice, autoprint]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.stateMessage}>
          <Spinner />
          <p style={{ marginTop: 12 }}>Loading invoice receipt...</p>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.stateMessage}>
          <Alert tone="danger">{error || 'Invoice not found.'}</Alert>
          <div style={{ marginTop: 16 }}>
            <Link href="/pos">
              <Button variant="secondary" className={styles.actionBtn}>
                Back to POS
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageContainer}>
      {/* Top Action Bar (hidden in @media print) */}
      <header className={styles.actionBar}>
        <div className={styles.actionLeft}>
          <Link href="/pos">
            <Button variant="secondary" className={styles.actionBtn}>
              ← Back to POS
            </Button>
          </Link>
          <span style={{ fontWeight: 600, color: 'var(--heading)' }}>
            Invoice #{invoice.invoiceNumber}
          </span>
        </div>

        {/* Template Switcher */}
        <div className={styles.templateSelector}>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.templateBtn} ${template === t.id ? styles.activeTemplate : ''}`}
              onClick={() => setTemplate(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.actionRight}>
          <Button onClick={handlePrint} className={styles.actionBtn}>
            🖨️ Print
          </Button>
        </div>
      </header>

      {/* Printable Preview Area */}
      <main className={styles.previewArea}>
        <ReceiptPrint
          invoice={invoice}
          template={template}
          isReprint={isReprint}
        />
      </main>
    </div>
  );
}
