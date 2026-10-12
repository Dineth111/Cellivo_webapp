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
export function renderTemplate(templateText, data = {}) {
  if (!templateText || typeof templateText !== 'string') return '';
  return templateText.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (data[key] !== undefined && data[key] !== null) {
      return String(data[key]);
    }
    // Aliases & fallback mappings
    if (key === 'customer_name') {
      const name = data.customer_name || data.customer || data.name;
      if (name) return String(name);
    }
    if (key === 'customer') {
      const name = data.customer_name || data.customer || data.name;
      if (name) return String(name);
    }
    if (key === 'shop' || key === 'shop_name') {
      const s = data.shop || data.shop_name || data.shopName;
      if (s) return String(s);
    }
    if (key === 'invoice_no') {
      const inv = data.invoice_no || data.invoiceNo;
      if (inv) return String(inv);
    }
    if (key === 'ticket_no') {
      const t = data.ticket_no || data.ticketNo;
      if (t) return String(t);
    }
    if (key === 'due_date') {
      const d = data.due_date || data.dueDate;
      if (d) return String(d);
    }
    if (key === 'amount') {
      if (data.amountCents != null) return formatRupees(data.amountCents);
      if (data.amount != null) return String(data.amount);
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

  return { subject: renderedSubject, body: renderedBody };
}

/**
 * Primary notification dispatch service.
 * Enqueues tenant notifications into NotificationLog.
 * Pre-tenant emails go straight to provider without creating a NotificationLog row.
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

  const { subject, body } = await resolveTemplate({
    tenantId,
    eventOrTemplate: template,
    channel,
    language: data.language || 'en',
    data,
  });

  // 2. Pre-tenant / platform emails (e.g. signup verification code)
  if (!tenantId) {
    if (channel === 'email') {
      const res = await getEmailProvider().send({
        to,
        subject: subject || 'Cellivo Verification',
        text: body,
        html: data.html || body.replace(/\n/g, '<br/>'),
      });
      return { success: true, messageId: res.messageId, direct: true };
    }
    return { success: false, error: 'NO_TENANT_ID' };
  }

  // 3. Mask recipient for privacy
  const masked = channel === 'in_app' ? (to || (userId ? `user:${userId}` : 'in_app')) : maskRecipient(to, channel);
  const partsCount = channel === 'sms' ? calculateSmsParts(body) : 1;

  // 4. Enqueue into NotificationLog inside tenant context
  const logDoc = {
    channel,
    recipient: masked,
    payload: {
      to: String(to || ''),
      body,
      subject,
      data,
    },
    template: typeof template === 'string' ? template : 'custom',
    event: DEFAULT_TEMPLATES[template] ? template : 'custom',
    subject,
    body,
    data,
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
  renderTemplate,
  resolveTemplate,
  notify,
  listInAppNotifications,
  countUnreadInApp,
  markInAppAsRead,
  markAllInAppAsRead,
};
