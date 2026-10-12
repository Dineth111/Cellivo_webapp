import { runAsPlatform, runWithContext } from '../../../core/tenantContext.js';
import NotificationLog from '../models/NotificationLog.model.js';
import InAppNotification from '../models/InAppNotification.model.js';
import Tenant from '../../tenants/Tenant.model.js';
import { calculateSmsParts } from '../utils/smsCounter.js';
import { getSmsProvider, getEmailProvider } from '../providers/provider.interface.js';

let workerInterval = null;

/**
 * Process a single notification item from the queue inside tenant context.
 */
export async function processItem(item) {
  const channel = item.channel;

  if (channel === 'in_app') {
    await InAppNotification.create({
      userId: item.userId || null,
      title: item.subject || 'Notification',
      body: item.body,
      level: item.data?.level || 'info',
      link: item.data?.link || '',
      data: item.data || {},
    });
    await NotificationLog.updateOne(
      { _id: item._id },
      { status: 'delivered', sentAt: new Date() }
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
        // Insufficient credits: mark failed and alert via in-app notification
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'failed',
            errorReason: 'NO_SMS_CREDITS',
            partsCount,
            creditsDeducted: 0,
          }
        );

        await InAppNotification.create({
          userId: item.userId || null,
          title: 'SMS Delivery Failed',
          body: 'SMS not sent: no credits left. Buy credits in Settings > Subscription.',
          level: 'warning',
          link: '/billing',
        });
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
            retryCount: nextRetry,
            nextRetryAt: new Date(Date.now() + backoffMs),
            errorReason: err.message,
            partsCount,
            creditsDeducted: partsCount,
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
          }
        );
      }
    }
    return;
  }

  if (channel === 'email') {
    try {
      const res = await getEmailProvider().send({
        to: item.payload?.to || item.recipient,
        subject: item.subject || 'Notification',
        text: item.body,
        html: item.data?.html || item.body.replace(/\n/g, '<br/>'),
      });

      await NotificationLog.updateOne(
        { _id: item._id },
        {
          status: 'sent',
          providerMessageId: res.messageId || '',
          sentAt: new Date(),
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
            retryCount: nextRetry,
            nextRetryAt: new Date(Date.now() + backoffMs),
            errorReason: err.message,
          }
        );
      } else {
        await NotificationLog.updateOne(
          { _id: item._id },
          {
            status: 'failed',
            retryCount: nextRetry,
            errorReason: err.message,
          }
        );
      }
    }
  }
}

/**
 * Queue worker: reads queued items across all tenants using runAsPlatform(),
 * then executes each inside runWithContext({ tenantId }).
 */
export async function processQueue() {
  const now = new Date();
  const items = await runAsPlatform(async () => {
    return await NotificationLog.find({
      status: 'queued',
      nextRetryAt: { $lte: now },
    })
      .select('+payload')
      .limit(20);
  });

  if (!items || items.length === 0) return 0;

  let count = 0;
  for (const item of items) {
    try {
      await runWithContext({ tenantId: item.tenantId }, async () => {
        await processItem(item);
      });
      count++;
    } catch (err) {
      console.error(`[notifications worker] Error processing item ${item._id}:`, err.message);
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
