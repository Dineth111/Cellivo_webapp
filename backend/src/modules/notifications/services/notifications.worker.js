import { runAsPlatform, runWithContext } from '../../../core/tenantContext.js';
import NotificationLog from '../models/NotificationLog.model.js';
import InAppNotification from '../models/InAppNotification.model.js';
import Tenant from '../../tenants/Tenant.model.js';
import { calculateSmsParts } from '../utils/smsCounter.js';
import { getSmsProvider, getEmailProvider } from '../providers/provider.interface.js';
import { escapeHtml } from './notifications.service.js';

let workerInterval = null;

/**
 * Process a single notification item from the queue inside tenant context.
 */
export async function processItem(item) {
  const channel = item.channel;

  if (channel === 'in_app') {
    await InAppNotification.create({
      tenantId: item.tenantId,
      userId: item.userId || null,
      title: item.subject || 'Notification',
      body: item.body,
      level: item.data?.level || 'info',
      link: item.data?.link || '',
      data: item.data || {},
    });
    await NotificationLog.updateOne(
      { _id: item._id },
      { status: 'delivered', sentAt: new Date(), lockedAt: null }
    );
    return;
  }

  if (channel === 'sms') {
    const partsCount = calculateSmsParts(item.body);
    const alreadyDeducted = (item.creditsDeducted || 0) > 0;

    if (!alreadyDeducted) {
      // Atomically deduct credits when sending for the first time
      const tenant = await runAsPlatform(async () =>
        Tenant.findOneAndUpdate(
          { _id: item.tenantId, smsCredits: { $gte: partsCount } },
          { $inc: { smsCredits: -partsCount } },
          { new: true }
        )
      );

      if (!tenant) {
        // Insufficient credits: mark failed and alert via in-app notification (max 1 per tenant per day)
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'failed',
            errorReason: 'NO_SMS_CREDITS',
            partsCount,
            creditsDeducted: 0,
            lockedAt: null,
          }
        );

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const existingWarning = await InAppNotification.findOne({
          tenantId: item.tenantId,
          level: 'warning',
          $or: [
            { 'data.code': 'NO_SMS_CREDITS' },
            { title: 'SMS Delivery Failed' },
          ],
          createdAt: { $gte: oneDayAgo },
        });

        if (!existingWarning) {
          await InAppNotification.create({
            tenantId: item.tenantId,
            userId: item.userId || null,
            title: 'SMS Delivery Failed',
            body: 'SMS not sent: no credits left. Buy credits in Settings > Subscription.',
            level: 'warning',
            link: '/billing',
            data: { code: 'NO_SMS_CREDITS' },
          });
        }
        return;
      }

      await NotificationLog.updateOne(
        { _id: item._id },
        { creditsDeducted: partsCount, partsCount }
      );
    }

    // Credits deducted, attempt send
    try {
      const res = await getSmsProvider().send({
        to: item.payload?.to || item.recipient,
        message: item.body,
      });

      await NotificationLog.updateOne(
        { _id: item._id },
        {
          status: 'sent',
          creditsDeducted: partsCount,
          partsCount,
          providerMessageId: res.messageId || '',
          sentAt: new Date(),
          lockedAt: null,
        }
      );
    } catch (err) {
      const nextRetry = (item.retryCount || 0) + 1;
      const maxRetries = item.maxRetries || 3;

      if (nextRetry < maxRetries) {
        // Schedule retry with exponential backoff: 1 min, 5 min, 25 min...
        const backoffMs = Math.pow(5, nextRetry) * 12_000;
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'queued',
            retryCount: nextRetry,
            nextRetryAt: new Date(Date.now() + backoffMs),
            errorReason: err.message,
            partsCount,
            creditsDeducted: partsCount,
            lockedAt: null,
          }
        );
      } else {
        // Final failure: refund credits atomically
        await runAsPlatform(async () =>
          Tenant.updateOne(
            { _id: item.tenantId },
            { $inc: { smsCredits: partsCount } }
          )
        );

        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'failed',
            retryCount: nextRetry,
            errorReason: err.message,
            creditsDeducted: 0,
            partsCount,
            lockedAt: null,
          }
        );
      }
    }
    return;
  }

  if (channel === 'email') {
    try {
      const emailHtml =
        item.data?.html ||
        item.payload?.data?.html ||
        (item.body ? escapeHtml(item.body).replace(/\n/g, '<br/>') : '');

      const res = await getEmailProvider().send({
        to: item.payload?.to || item.recipient,
        subject: item.subject || 'Notification',
        text: item.body,
        html: emailHtml,
      });

      await NotificationLog.updateOne(
        { _id: item._id },
        {
          status: 'sent',
          providerMessageId: res.messageId || '',
          sentAt: new Date(),
          lockedAt: null,
        }
      );
    } catch (err) {
      const nextRetry = (item.retryCount || 0) + 1;
      const maxRetries = item.maxRetries || 3;

      if (nextRetry < maxRetries) {
        const backoffMs = Math.pow(5, nextRetry) * 12_000;
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'queued',
            retryCount: nextRetry,
            nextRetryAt: new Date(Date.now() + backoffMs),
            errorReason: err.message,
            lockedAt: null,
          }
        );
      } else {
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'failed',
            retryCount: nextRetry,
            errorReason: err.message,
            lockedAt: null,
          }
        );
      }
    }
  }
}

/**
 * Queue worker: reads queued items across all tenants using runAsPlatform(),
 * atomically claims them before execution, and handles stuck jobs.
 */
export async function processQueue() {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  // 1. Reset items stuck in sending for more than 5 minutes back to queued
  await runAsPlatform(async () => {
    await NotificationLog.updateMany(
      { status: 'sending', lockedAt: { $lt: fiveMinutesAgo } },
      { $set: { status: 'queued', lockedAt: null } }
    );
  });

  // 2. Query candidates ready for processing
  const candidates = await runAsPlatform(async () => {
    return await NotificationLog.find({
      status: 'queued',
      nextRetryAt: { $lte: now },
    })
      .select('_id tenantId')
      .limit(20);
  });

  if (!candidates || candidates.length === 0) return 0;

  let count = 0;
  for (const candidate of candidates) {
    // 3. Atomically claim queued item (queued -> sending with lockedAt)
    const claimed = await runAsPlatform(async () => {
      return await NotificationLog.findOneAndUpdate(
        { _id: candidate._id, status: 'queued' },
        { $set: { status: 'sending', lockedAt: new Date() } },
        { new: true }
      ).select('+payload');
    });

    // Skip if already claimed by another concurrent worker
    if (!claimed) continue;

    try {
      await runWithContext({ tenantId: claimed.tenantId }, async () => {
        await processItem(claimed);
      });
      count++;
    } catch (err) {
      console.error(`[notifications worker] Error processing item ${claimed._id}:`, err.message);
    }
  }
  return count;
}

/**
 * Starts worker interval in server.js.
 */
export function startNotificationWorker(intervalMs = 5000) {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    processQueue().catch((err) => {
      console.error('[notification worker interval error]', err);
    });
  }, intervalMs).unref();
}

export function stopNotificationWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

export default {
  processItem,
  processQueue,
  startNotificationWorker,
  stopNotificationWorker,
};
