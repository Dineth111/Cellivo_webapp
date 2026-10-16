import NotificationTemplate from './models/NotificationTemplate.model.js';
import NotificationLog from './models/NotificationLog.model.js';
import InAppNotification from './models/InAppNotification.model.js';
import { DEFAULT_TEMPLATES } from './models/defaultTemplates.js';
import { pick, str, requireId, escapeRegex, pageParams } from '../../core/validate.js';
import { badRequest, notFound } from '../../core/errors.js';
import audit from '../../core/audit.js';

/**
 * List all templates for the tenant, combining defaults with any tenant customizations.
 */
export async function listTemplates(req, res) {
  const customTemplates = await NotificationTemplate.find().lean();
  const customMap = new Map();
  for (const t of customTemplates) {
    customMap.set(`${t.event}:${t.channel}:${t.language || 'en'}`, t);
  }

  const combined = [];
  for (const [eventKey, def] of Object.entries(DEFAULT_TEMPLATES)) {
    for (const [channel, tmpl] of Object.entries(def.channels || {})) {
      const key = `${eventKey}:${channel}:en`;
      const custom = customMap.get(key);
      combined.push({
        event: eventKey,
        channel,
        language: 'en',
        subject: custom ? custom.subject : tmpl.subject || '',
        body: custom ? custom.body : tmpl.body || '',
        isCustom: !!custom,
        isActive: custom ? custom.isActive : true,
      });
    }
  }

  // Also include any custom templates that might be custom events
  for (const [key, custom] of customMap.entries()) {
    if (!combined.some((c) => `${c.event}:${c.channel}:${c.language}` === key)) {
      combined.push({
        event: custom.event,
        channel: custom.channel,
        language: custom.language || 'en',
        subject: custom.subject || '',
        body: custom.body,
        isCustom: true,
        isActive: custom.isActive,
      });
    }
  }

  res.json({ success: true, data: combined });
}

/**
 * Update or create a custom template for an event and channel.
 */
export async function saveTemplate(req, res) {
  const { event, channel } = req.params;
  if (!event || !channel || !['sms', 'email', 'in_app'].includes(channel)) {
    throw badRequest('Invalid event or channel parameters');
  }

  if (!DEFAULT_TEMPLATES[event]) {
    throw badRequest(`Invalid template event: ${event}`);
  }

  const bodyData = pick(req.body, ['body', 'subject', 'language', 'isActive']);
  const bodyText = str(bodyData.body);
  if (!bodyText) throw badRequest('Template body is required');

  const language = str(bodyData.language) || 'en';
  if (!['en', 'si', 'ta'].includes(language)) {
    throw badRequest('Invalid language. Supported languages: en, si, ta');
  }

  const maxBodyLength = channel === 'email' ? 10000 : 1000;
  if (bodyText.length > maxBodyLength) {
    throw badRequest(`${channel.toUpperCase()} template body must not exceed ${maxBodyLength} characters`);
  }

  const subject = str(bodyData.subject) || '';
  const isActive = bodyData.isActive !== false;

  const existing = await NotificationTemplate.findOne({ event, channel, language });

  const updated = await NotificationTemplate.findOneAndUpdate(
    { event, channel, language },
    { $set: { body: bodyText, subject, isActive } },
    { upsert: true, new: true, runValidators: true }
  );

  await audit.record({
    action: 'notification_template.update',
    entity: 'NotificationTemplate',
    entityId: updated._id,
    before: existing ? { body: existing.body, subject: existing.subject, isActive: existing.isActive } : null,
    after: { body: updated.body, subject: updated.subject, isActive: updated.isActive },
  });

  res.json({ success: true, data: updated, message: 'Template updated successfully' });
}

/**
 * List notification delivery logs (paginated, filtered, masked).
 */
export async function listLogs(req, res) {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};

  if (req.query.status && ['queued', 'sending', 'sent', 'delivered', 'failed'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  if (req.query.channel && ['sms', 'email', 'in_app'].includes(req.query.channel)) {
    filter.channel = req.query.channel;
  }
  if (req.query.search) {
    const rawSearch = String(req.query.search).trim().slice(0, 100);
    if (rawSearch) {
      const reg = new RegExp(escapeRegex(rawSearch), 'i');
      filter.$or = [{ recipient: reg }, { template: reg }, { subject: reg }, { body: reg }];
    }
  }

  const [logs, total] = await Promise.all([
    NotificationLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    NotificationLog.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: logs,
    page,
    limit,
    total,
    count: logs.length,
  });
}

/**
 * Resend a failed notification.
 */
export async function resendLog(req, res) {
  const id = requireId(req.params.id);
  const log = await NotificationLog.findById(id);
  if (!log) throw notFound('Notification log not found');

  if (log.status !== 'failed') {
    throw badRequest('Only failed notifications can be resent');
  }

  log.status = 'queued';
  log.retryCount = 0;
  log.errorReason = '';
  log.nextRetryAt = new Date();
  await log.save();

  await audit.record({
    action: 'notification_log.resend',
    entity: 'NotificationLog',
    entityId: log._id,
    after: { channel: log.channel, recipient: log.recipient, template: log.template },
  });

  res.json({ success: true, data: log, message: 'Notification queued for retry' });
}

/**
 * Get in-app notifications for current user.
 */
export async function getInAppList(req, res) {
  const userId = req.auth?.userId;
  const unreadOnly = req.query.unread === 'true';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const query = { $or: [{ userId }, { userId: null }] };
  if (unreadOnly) query.readAt = null;

  const [items, unreadCount] = await Promise.all([
    InAppNotification.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
    InAppNotification.countDocuments({ $or: [{ userId }, { userId: null }], readAt: null }),
  ]);

  res.json({ success: true, data: items, unreadCount });
}

/**
 * Mark an in-app notification as read.
 */
export async function markInAppRead(req, res) {
  const id = requireId(req.params.id);
  const userId = req.auth?.userId;

  const item = await InAppNotification.findOneAndUpdate(
    { _id: id, $or: [{ userId }, { userId: null }] },
    { $set: { readAt: new Date() } },
    { new: true }
  );

  if (!item) throw notFound('Notification not found');
  res.json({ success: true, data: item });
}

/**
 * Mark all in-app notifications as read for current user.
 */
export async function markAllInAppRead(req, res) {
  const userId = req.auth?.userId;
  await InAppNotification.updateMany(
    { $or: [{ userId }, { userId: null }], readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ success: true, message: 'All notifications marked as read' });
}

export default {
  listTemplates,
  saveTemplate,
  listLogs,
  resendLog,
  getInAppList,
  markInAppRead,
  markAllInAppRead,
};
