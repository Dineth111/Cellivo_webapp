'use client';

import { useEffect, useState } from 'react';
import { admin } from '../../lib/adminApi';
import { Alert, Button, Card, Field, Spinner, Table, date } from '../../components/ui';

// One list + edit panel for the simple platform collections (A-04, A-07 to A-16). Each entry says which
// columns to show and which fields the form edits; the API whitelists the same fields.
// field: [name, label, kind, options]. kind: text | number | date | check | area | csv | select. Names may be dotted (price.LKR).
const f = (name, label, kind = 'text', options) => [name, label, kind, options];

export const COLLECTIONS = {
  'Coupons': {
    path: 'coupons', roles: ['finance', 'sales'], noDelete: true,
    columns: ['code', 'type', 'percent', 'fixed.LKR', 'validTo', 'usedCount', 'active'],
    fields: [f('code', 'Code'), f('type', 'Type', 'select', ['percent', 'fixed']), f('percent', 'Percent off', 'number'), f('fixed.LKR', 'Fixed off (LKR)', 'number'), f('fixed.USD', 'Fixed off (USD)', 'number'),
      f('validTo', 'Valid until', 'date'), f('maxUses', 'Max uses', 'number'), f('perTenantLimit', 'Uses per shop', 'number'), f('plans', 'Plans (comma separated, empty = all)', 'csv'), f('active', 'Active', 'check')],
  },
  'Affiliates': {
    path: 'affiliates', roles: ['sales', 'finance'], noDelete: true,
    columns: ['code', 'name', 'email', 'status', 'commissionPercent'],
    fields: [f('code', 'Code'), f('name', 'Name'), f('email', 'Email'), f('status', 'Status', 'select', ['pending', 'approved', 'rejected']), f('commissionPercent', 'Commission %', 'number')],
  },
  'Payouts': {
    path: 'payouts', roles: ['finance'], noDelete: true,
    columns: ['affiliateId', 'amount', 'currency', 'paidAt', 'note'],
    fields: [f('affiliateId', 'Affiliate id'), f('amount', 'Amount (minor units, e.g. cents)', 'number'), f('currency', 'Currency', 'select', ['LKR', 'USD']), f('note', 'Note')],
  },
  'Tickets': {
    path: 'tickets', roles: ['support'], noDelete: true, noCreate: true,
    columns: ['subject', 'priority', 'status', 'assignee', 'createdAt'],
    fields: [f('status', 'Status', 'select', ['open', 'pending', 'resolved', 'closed']), f('priority', 'Priority', 'select', ['low', 'normal', 'high', 'urgent']), f('assignee', 'Assignee')],
  },
  'Announcements': {
    path: 'announcements', roles: ['content', 'support'],
    columns: ['title', 'startsAt', 'endsAt', 'plans'],
    fields: [f('title', 'Title'), f('body', 'Message', 'area'), f('startsAt', 'Starts', 'date'), f('endsAt', 'Ends', 'date'), f('plans', 'Plans (comma separated, empty = all)', 'csv'), f('countries', 'Countries (e.g. LK, IN)', 'csv')],
  },
  'Emails': {
    path: 'email-templates', roles: ['content'], noDelete: true,
    columns: ['key', 'subject'],
    fields: [f('key', 'Key (welcome, verification, trial_ending, payment_failed, receipt, suspension)'), f('subject', 'Subject'), f('body', 'Body', 'area')],
  },
  'Website': {
    path: 'cms', roles: ['content'],
    columns: ['type', 'title', 'slug', 'status'],
    fields: [f('type', 'Type', 'select', ['blog', 'logo', 'testimonial', 'faq', 'legal', 'seo', 'redirect']), f('title', 'Title'), f('slug', 'Slug'), f('body', 'Content', 'area'), f('status', 'Status', 'select', ['draft', 'scheduled', 'published']), f('publishAt', 'Publish at', 'date')],
  },
  'Phone models': {
    path: 'phone-models', roles: ['content', 'support'],
    columns: ['brand', 'name', 'variants'],
    fields: [f('brand', 'Brand'), f('name', 'Model'), f('variants', 'Variants (comma separated)', 'csv')],
  },
  'SMS packages': {
    path: 'sms-packages', roles: ['finance'], noDelete: true,
    columns: ['name', 'credits', 'price.LKR', 'price.USD', 'active'],
    fields: [f('name', 'Name'), f('credits', 'Credits', 'number'), f('price.LKR', 'Price (LKR)', 'number'), f('price.USD', 'Price (USD)', 'number'), f('active', 'Active', 'check')],
  },
  'Flags': {
    path: 'flags', roles: [],
    columns: ['key', 'description', 'enabled'],
    fields: [f('key', 'Key'), f('description', 'Description'), f('enabled', 'On for everyone', 'check')],
  },
  'Maintenance': {
    path: 'maintenance', roles: ['support', 'content'],
    columns: ['title', 'startsAt', 'endsAt', 'notice'],
    fields: [f('title', 'Title'), f('startsAt', 'Starts', 'date'), f('endsAt', 'Ends', 'date'), f('notice', 'Notice shown to shops')],
  },
};

const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const setPath = (o, path, value) => {
  const keys = path.split('.');
  keys.slice(0, -1).reduce((v, k) => (v[k] ??= {}), o)[keys.at(-1)] = value;
};

const show = (v, kind) => {
  if (v === undefined || v === null || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.join(', ') || '-';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return date(v);
  return String(v);
};

/** Form state -> request body: numbers, arrays and dates in the shapes the API wants; untouched empty fields are left out. */
function toBody(fields, vals) {
  const body = {};
  for (const [name, , kind] of fields) {
    const v = vals[name];
    if (v === undefined || (v === '' && kind !== 'text' && kind !== 'area')) continue;
    setPath(body, name, kind === 'number' ? Number(v) : kind === 'csv' ? v.split(',').map((s) => s.trim()).filter(Boolean) : kind === 'date' ? new Date(v).toISOString() : v);
  }
  return body;
}
const toForm = (fields, row) => Object.fromEntries(fields.map(([name, , kind]) => {
  const v = get(row, name);
  return [name, kind === 'csv' ? (v || []).join(', ') : kind === 'date' ? (v ? String(v).slice(0, 10) : '') : v ?? (kind === 'check' ? false : '')];
}));

export function Collection({ cfg, title }) {
  const [rows, setRows] = useState(null);
  const [n, setN] = useState(0);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, row = editing
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState({ tone: 'success', text: '' });
  const reload = () => setN((x) => x + 1);

  useEffect(() => {
    let live = true;
    admin(`/${cfg.path}?limit=100`)
      .then((r) => live && setRows(r.data))
      .catch((e) => live && (setRows([]), setMsg({ tone: 'danger', text: e.message })));
    return () => { live = false; };
  }, [cfg.path, n]);

  const open = (row) => { setEditing(row); setVals(row._id ? toForm(cfg.fields, row) : Object.fromEntries(cfg.fields.map(([k, , kind]) => [k, kind === 'check' ? true : kind === 'select' ? cfg.fields.find((x) => x[0] === k)[3][0] : '']))); setMsg({ tone: 'success', text: '' }); };
  const save = (e) => {
    e.preventDefault();
    let body;
    try { body = toBody(cfg.fields, vals); } catch { return setMsg({ tone: 'danger', text: 'Check the dates.' }); }
    admin(editing._id ? `/${cfg.path}/${editing._id}` : `/${cfg.path}`, { method: editing._id ? 'PUT' : 'POST', body })
      .then(() => { setEditing(null); setMsg({ tone: 'success', text: 'Saved.' }); reload(); })
      .catch((err) => setMsg({ tone: 'danger', text: err.message }));
  };
  const remove = (row) => window.confirm('Delete this entry?') && admin(`/${cfg.path}/${row._id}`, { method: 'DELETE' })
    .then(() => { setMsg({ tone: 'success', text: 'Deleted.' }); reload(); })
    .catch((err) => setMsg({ tone: 'danger', text: err.message }));

  const set = (k, kind) => (e) => setVals({ ...vals, [k]: kind === 'check' ? e.target.checked : e.target.value });

  return (
    <>
      {msg.text && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {editing && (
        <Card title={editing._id ? `Edit ${title}` : `New ${title}`}>
          <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
            {cfg.fields.map(([k, label, kind, options]) => {
              if (kind === 'check') return <label key={k} style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={!!vals[k]} onChange={set(k, kind)} />{label}</label>;
              if (kind === 'select') return <Field key={k} label={label} as="select" value={vals[k]} onChange={set(k)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</Field>;
              if (kind === 'area') return <Field key={k} label={label} as="textarea" rows={5} value={vals[k]} onChange={set(k)} />;
              return <Field key={k} label={label} type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'} step={kind === 'number' ? 'any' : undefined} value={vals[k]} onChange={set(k)} />;
            })}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button>Save</Button>
              <Button variant="secondary" type="button" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
      <Card title={title}>
        {!cfg.noCreate && !editing && <div><Button onClick={() => open({})}>Add new</Button></div>}
        {!rows ? <Spinner /> : rows.length === 0 ? <span>Nothing here yet.</span> : (
          <Table head={[...cfg.columns.map((c) => c.split('.').at(-1).replace(/([A-Z])/g, ' $1').toLowerCase()), '']}>
            {rows.map((r) => (
              <tr key={r._id}>
                {cfg.columns.map((c) => <td key={c}>{show(get(r, c))}</td>)}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Button variant="secondary" onClick={() => open(r)}>Edit</Button>{' '}
                  {!cfg.noDelete && <Button variant="secondary" onClick={() => remove(r)}>Delete</Button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
