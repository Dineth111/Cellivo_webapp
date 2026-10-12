import { runWithContext } from '../../../core/tenantContext.js';
import NotificationTemplate from '../models/NotificationTemplate.model.js';
import NotificationLog from '../models/NotificationLog.model.js';
import InAppNotification from '../models/InAppNotification.model.js';
import { DEFAULT_TEMPLATES } from '../models/defaultTemplates.js';
import { maskRecipient } from '../utils/mask.js';
import { calculateSmsParts } from '../utils/smsCounter.js';
import { getEmailProvider } from '../providers/provider.interface.js';
import { formatRupees } from '../../pos/money.js';

/**
 * Replace placeholders like {customer_name}, {amount}, {ticket_no} etc.
 * Uses {customer_name} as standard merge field.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace placeholders like {customer_name}, {amount}, {ticket_no} etc.
 * Uses {customer_name} as standard merge field.
 * Supports escaping merge-field values for HTML contexts.
 */
export function renderTemplate(templateText, data = {}, { escape = false } = {}) {
  if (!templateText || typeof templateText !== 'string') return '';
  const formatVal = (v) => (escape ? escapeHtml(v) : String(v));
  return templateText.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (data[key] !== undefined && data[key] !== null) {
      return formatVal(data[key]);
    }
    // Aliases & fallback mappings
    if (key === 'customer_name' || key === 'customer') {
      const name = data.customer_name || data.customer || data.name;
      if (name) return formatVal(name);
    }
    if (key === 'shop' || key === 'shop_name') {
      const s = data.shop || data.shop_name || data.shopName;
      if (s) return formatVal(s);
    }
    if (key === 'invoice_no') {
      const inv = data.invoice_no || data.invoiceNo;
      if (inv) return formatVal(inv);
    }
    if (key === 'ticket_no') {
      const t = data.ticket_no || data.ticketNo;
      if (t) return formatVal(t);
    }
    if (key === 'due_date') {
      const d = data.due_date || data.dueDate;
      if (d) return formatVal(d);
    }
    if (key === 'amount') {
      if (data.amountCents != null) return formatVal(formatRupees(data.amountCents));
      if (data.amount != null) return formatVal(data.amount);
    }
    return match;
  });
}

/**
 * Resolve template content (body and subject) from tenant custom templates or defaults.
 */
export async function resolveTemplate({ tenantId, eventOrTemplate, channel, language = 'en', data = {} }) {
  let subject = '';
  let body = '';

  if (tenantId) {
    try {
      const custom = await runWithContext({ tenantId }, async () => {
        return await NotificationTemplate.findOne({
          event: eventOrTemplate,
          channel,
          language,
          isActive: true,
        }).lean();
      });
      if (custom) {
        subject = custom.subject || '';
        body = custom.body;
      }
    } catch {
      // If error or no match, fall back to default
    }
  }

  if (!body) {
    const def = DEFAULT_TEMPLATES[eventOrTemplate]?.channels?.[channel];
    if (def) {
      subject = def.subject || '';
      body = def.body || '';
    } else {
      // Raw template text passed directly
      body = eventOrTemplate || '';
      subject = data.subject || '';
    }
  }

  const renderedSubject = renderTemplate(subject, data);
  const renderedBody = renderTemplate(body, data);
  const renderedHtml = renderTemplate(body, data, { escape: true }).replace(/\n/g, '<br/>');

  return { subject: renderedSubject, body: renderedBody, html: renderedHtml };
}

/**
 * Primary notification dispatch service.
 * Enqueues tenant notifications into NotificationLog.
 * Pre-tenant emails, password resets, and token-bearing emails go straight to provider
 * without creating a NotificationLog row to prevent plaintext token storage.
 */
export async function notify({
  tenantId,
  branchId = null,
  channel = 'sms',
  to,
  template,
  data = {},
  userId = null,
  isPromotional = false,
  session = null,
}) {
  // 1. Marketing opt-out check for promotional messages
  if (isPromotional) {
    const optedOut = data.marketingConsent === false || data.optOut === true;
    if (optedOut) {
      return { success: false, skipped: true, reason: 'MARKETING_OPT_OUT' };
    }
  }

  const { subject, body, html } = await resolveTemplate({
    tenantId,
    eventOrTemplate: template,
    channel,
    language: data.language || 'en',
    data,
  });

  const hasToken =
    template === 'password_reset' ||
    template === 'staff_invite' ||
    Boolean(data.token) ||
    (typeof data.link === 'string' && data.link.includes('token=')) ||
    (typeof body === 'string' && body.includes('token='));

  // 2. Pre-tenant / platform emails and security/token emails go straight to provider without creating a NotificationLog row
  if (!tenantId || (channel === 'email' && hasToken)) {
    if (channel === 'email') {
      const res = await getEmailProvider().send({
        to,
        subject: subject || (template === 'password_reset' ? 'Password Reset' : 'Cellivo Notification'),
        text: body,
        html: data.html || html || body.replace(/\n/g, '<br/>'),
      });
      return { success: true, messageId: res.messageId, direct: true };
    }
    return { success: false, error: 'NO_TENANT_ID' };
  }

  // 3. Mask recipient for privacy
  const masked = channel === 'in_app' ? (to || (userId ? `user:${userId}` : 'in_app')) : maskRecipient(to, channel);
  const partsCount = channel === 'sms' ? calculateSmsParts(body) : 1;

  // Redact token from body/payload/data if ever stored
  const redactToken = (text) =>
    typeof text === 'string'
      ? text.replace(/([?&]token=)[a-zA-Z0-9_\-]+/gi, '$1[REDACTED]')
      : text;

  const sanitizedBody = hasToken ? redactToken(body) : body;
  const sanitizedData = hasToken
    ? {
        ...data,
        ...(data.token ? { token: '[REDACTED]' } : {}),
        ...(typeof data.link === 'string' ? { link: redactToken(data.link) } : {}),
      }
    : data;

  // 4. Enqueue into NotificationLog inside tenant context
  const logDoc = {
    channel,
    recipient: masked,
    payload: {
      to: String(to || ''),
      body: sanitizedBody,
      subject,
      data: { ...sanitizedData, html: sanitizedData.html || html },
    },
    template: typeof template === 'string' ? template : 'custom',
    event: DEFAULT_TEMPLATES[template] ? template : 'custom',
    subject,
    body: sanitizedBody,
    data: { ...sanitizedData, html: sanitizedData.html || html },
    status: 'queued',
    partsCount,
    creditsDeducted: 0,
    nextRetryAt: new Date(),
    userId: userId || null,
    branchId: branchId || null,
  };

  const savedLog = await runWithContext({ tenantId }, async () => {
    if (session) {
      const created = await NotificationLog.create([logDoc], { session });
      return created[0];
    }
    return await NotificationLog.create(logDoc);
  });

  return {
    success: true,
    logId: savedLog._id,
    messageId: String(savedLog._id),
  };
}

/**
 * List in-app notifications for the logged-in user.
 */
export async function listInAppNotifications(userId, { unreadOnly = false, limit = 20 } = {}) {
  const query = {
    $or: [{ userId }, { userId: null }],
  };
  if (unreadOnly) {
    query.readAt = null;
  }
  return await InAppNotification.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * Get count of unread in-app notifications.
 */
export async function countUnreadInApp(userId) {
  return await InAppNotification.countDocuments({
    $or: [{ userId }, { userId: null }],
    readAt: null,
  });
}

/**
 * Mark a single in-app notification as read.
 */
export async function markInAppAsRead(notificationId, userId) {
  const query = { _id: notificationId };
  if (userId) {
    query.$or = [{ userId }, { userId: null }];
  }
  return await InAppNotification.findOneAndUpdate(
    query,
    { $set: { readAt: new Date() } },
    { new: true }
  );
}

/**
 * Mark all in-app notifications for a user as read.
 */
export async function markAllInAppAsRead(userId) {
  const query = {
    $or: [{ userId }, { userId: null }],
    readAt: null,
  };
  return await InAppNotification.updateMany(query, { $set: { readAt: new Date() } });
}

export default {
  escapeHtml,
  renderTemplate,
  resolveTemplate,
  notify,
  listInAppNotifications,
  countUnreadInApp,
  markInAppAsRead,
  markAllInAppAsRead,
};
