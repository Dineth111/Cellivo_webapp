'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  getNotificationTemplates,
  updateNotificationTemplate,
  getNotificationLogs,
  resendNotificationLog,
  getAuthProfile,
  hasSession,
} from '../../lib/api';
import {
  Alert,
  AppHeader,
  Button,
  Card,
  Field,
  Hero,
  Spinner,
  Table,
  Badge,
  date,
} from '../../components/ui';

const MERGE_TAGS = [
  '{customer_name}',
  '{invoice_no}',
  '{ticket_no}',
  '{amount}',
  '{shop}',
  '{status}',
  '{link}',
  '{due_date}',
];

export default function NotificationsPage() {
  const [tab, setTab] = useState('templates'); // 'templates' | 'logs'
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // Templates state
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Logs state
  const [logs, setLogs] = useState([]);
  const [logStatus, setLogStatus] = useState('');
  const [logChannel, setLogChannel] = useState('');
  const [logSearch, setLogSearch] = useState('');
  const [resendingId, setResendingId] = useState(null);

  const loadProfileAndData = useCallback(async () => {
    if (!hasSession()) {
      setLoading(false);
      return;
    }
    try {
      const profile = await getAuthProfile();
      setUser(profile.data);

      const [tplRes, logsRes] = await Promise.all([
        getNotificationTemplates(),
        getNotificationLogs(),
      ]);
      setTemplates(tplRes.data || []);
      setLogs(logsRes.data || []);
      if (tplRes.data?.length > 0) {
        setSelectedTemplate(tplRes.data[0]);
        setEditBody(tplRes.data[0].body || '');
        setEditSubject(tplRes.data[0].subject || '');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) loadProfileAndData();
    });
    return () => { ignore = true; };
  }, [loadProfileAndData]);

  const handleSelectTemplate = (t) => {
    setSelectedTemplate(t);
    setEditBody(t.body || '');
    setEditSubject(t.subject || '');
    setError('');
    setMsg('');
  };

  const handleSaveTemplate = async (e) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    setSavingTemplate(true);
    setError('');
    setMsg('');
    try {
      await updateNotificationTemplate(selectedTemplate.event, selectedTemplate.channel, {
        body: editBody,
        subject: editSubject,
      });
      setMsg(`Template for ${selectedTemplate.event} (${selectedTemplate.channel}) saved.`);
      const tplRes = await getNotificationTemplates();
      setTemplates(tplRes.data || []);
      const updated = tplRes.data.find(
        (t) => t.event === selectedTemplate.event && t.channel === selectedTemplate.channel
      );
      if (updated) setSelectedTemplate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleFilterLogs = async (e) => {
    if (e) e.preventDefault();
    setError('');
    try {
      const params = new URLSearchParams();
      if (logStatus) params.set('status', logStatus);
      if (logChannel) params.set('channel', logChannel);
      if (logSearch) params.set('search', logSearch.slice(0, 100));
      const res = await getNotificationLogs(params.toString());
      setLogs(res.data || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResend = async (id) => {
    setResendingId(id);
    setError('');
    setMsg('');
    try {
      await resendNotificationLog(id);
      setMsg('Notification queued for retry.');
      await handleFilterLogs();
    } catch (err) {
      setError(err.message);
    } finally {
      setResendingId(null);
    }
  };

  const insertMergeTag = (tag) => {
    setEditBody((prev) => `${prev} ${tag} `);
  };

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ maxWidth: 600, margin: '60px auto', padding: 20 }}>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to view notification settings.
        </Alert>
      </div>
    );
  }

  const badgeToneForStatus = (status) => {
    if (status === 'delivered' || status === 'sent') return 'success';
    if (status === 'queued') return 'warning';
    return 'danger';
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 60 }}>
      <AppHeader chip="Notifications">
        <Link
          href="/"
          style={{
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 16px',
            color: 'var(--brand)',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          ← Shop Dashboard
        </Link>
      </AppHeader>

      <main style={{ maxWidth: 1100, margin: '24px auto', padding: '0 16px' }}>
        <Hero
          badges={[['F-18 NOTIFICATIONS', false]]}
          title="Notification Service"
          subtitle="Manage SMS, email and in-app templates, view delivery status logs, and configure customer alerts."
        />

        {error && (
          <div style={{ marginTop: 16 }}>
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
        {msg && (
          <div style={{ marginTop: 16 }}>
            <Alert tone="success">{msg}</Alert>
          </div>
        )}

        {/* Tab navigation: touch targets at least 44x44px */}
        <div style={{ display: 'flex', gap: 12, marginTop: 24, marginBottom: 20 }}>
          <Button
            type="button"
            variant={tab === 'templates' ? undefined : 'secondary'}
            onClick={() => setTab('templates')}
            style={{ minHeight: 44, minWidth: 140 }}
          >
            Templates
          </Button>
          <Button
            type="button"
            variant={tab === 'logs' ? undefined : 'secondary'}
            onClick={() => {
              setTab('logs');
              handleFilterLogs();
            }}
            style={{ minHeight: 44, minWidth: 140 }}
          >
            Delivery Logs
          </Button>
        </div>

        {tab === 'templates' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
            {/* Template list */}
            <Card title="Available Templates">
              <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                {templates.map((t) => {
                  const isSel =
                    selectedTemplate &&
                    selectedTemplate.event === t.event &&
                    selectedTemplate.channel === t.channel;
                  return (
                    <button
                      key={`${t.event}:${t.channel}`}
                      type="button"
                      onClick={() => handleSelectTemplate(t)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '12px 14px',
                        marginBottom: 6,
                        border: '1px solid',
                        borderColor: isSel ? 'var(--primary)' : 'var(--border)',
                        background: isSel ? 'var(--tint)' : 'var(--surface)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        minHeight: 44,
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: 13, color: 'var(--heading)' }}>
                          {t.event.replace(/_/g, ' ')}
                        </strong>
                        <div style={{ fontSize: 11, color: 'var(--secondary)' }}>
                          Channel: {t.channel.toUpperCase()}
                        </div>
                      </div>
                      {t.isCustom && <Badge tone="warning">Custom</Badge>}
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Template Editor */}
            {selectedTemplate && (
              <Card title={`Edit Template: ${selectedTemplate.event.replace(/_/g, ' ')} (${selectedTemplate.channel.toUpperCase()})`}>
                <form onSubmit={handleSaveTemplate}>
                  {selectedTemplate.channel === 'email' && (
                    <Field
                      label="Email Subject"
                      value={editSubject}
                      onChange={(e) => setEditSubject(e.target.value)}
                      placeholder="Subject line with merge fields"
                    />
                  )}

                  <div style={{ marginTop: 12 }}>
                    <Field
                      label="Template Body"
                      as="textarea"
                      rows={8}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      hint="Supports UTF-8 characters (Sinhala, Tamil, English) and merge fields."
                    />
                  </div>

                  {/* Merge tags helper */}
                  <div style={{ marginTop: 12, marginBottom: 20 }}>
                    <span style={{ fontSize: 12, color: 'var(--secondary)', display: 'block', marginBottom: 6 }}>
                      Insert merge fields:
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {MERGE_TAGS.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => insertMergeTag(tag)}
                          style={{
                            background: 'var(--tint)',
                            border: '1px solid var(--border)',
                            color: 'var(--brand)',
                            fontSize: 12,
                            padding: '4px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            minHeight: 32,
                          }}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  <Button type="submit" disabled={savingTemplate} style={{ minHeight: 44, minWidth: 140 }}>
                    {savingTemplate ? 'Saving…' : 'Save Template'}
                  </Button>
                </form>
              </Card>
            )}
          </div>
        ) : (
          /* Delivery Logs Tab */
          <Card title="Notification Delivery Logs">
            {/* Filters */}
            <form
              onSubmit={handleFilterLogs}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 20 }}
            >
              <div style={{ width: 140 }}>
                <Field
                  label="Channel"
                  as="select"
                  value={logChannel}
                  onChange={(e) => setLogChannel(e.target.value)}
                >
                  <option value="">All Channels</option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                  <option value="in_app">In-App</option>
                </Field>
              </div>

              <div style={{ width: 140 }}>
                <Field
                  label="Status"
                  as="select"
                  value={logStatus}
                  onChange={(e) => setLogStatus(e.target.value)}
                >
                  <option value="">All Statuses</option>
                  <option value="queued">Queued</option>
                  <option value="sent">Sent</option>
                  <option value="delivered">Delivered</option>
                  <option value="failed">Failed</option>
                </Field>
              </div>

              <div style={{ flex: 1, minWidth: 200 }}>
                <Field
                  label="Search"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  placeholder="Recipient, event or body text"
                  maxLength={100}
                />
              </div>

              <Button type="submit" style={{ minHeight: 44, minWidth: 100 }}>
                Filter
              </Button>
            </form>

            <Table head={['Recipient', 'Channel', 'Event', 'Status', 'Parts / Credits', 'Date', 'Action']}>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                    No delivery logs found.
                  </td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l._id}>
                    <td>
                      <code>{l.recipient}</code>
                    </td>
                    <td>{l.channel?.toUpperCase()}</td>
                    <td>{l.event || l.template}</td>
                    <td>
                      {/* Status as text not colour only */}
                      <Badge tone={badgeToneForStatus(l.status)}>
                        {l.status?.toUpperCase()}
                      </Badge>
                      {l.errorReason && (
                        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                          {l.errorReason}
                        </div>
                      )}
                    </td>
                    <td>
                      {l.channel === 'sms'
                        ? `${l.partsCount || 1} part(s) (${l.creditsDeducted || 0} cr)`
                        : '-'}
                    </td>
                    <td>{date(l.createdAt)}</td>
                    <td>
                      {l.status === 'failed' && (
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={resendingId === l._id}
                          onClick={() => handleResend(l._id)}
                          style={{ minHeight: 36, padding: '0 12px', fontSize: 12 }}
                        >
                          {resendingId === l._id ? 'Retrying…' : 'Resend'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </Table>
          </Card>
        )}
      </main>
    </div>
  );
}
