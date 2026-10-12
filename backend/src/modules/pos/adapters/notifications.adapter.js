import { getContext } from '../../../core/tenantContext.js';
import * as notificationsService from '../../notifications/services/notifications.service.js';

/**
 * Sends an SMS to a customer phone number via Developer 5's notification service.
 *
 * @param {{ to: string, template: string, data?: object }} params
 * @returns {Promise<{ success: boolean, messageId: string }>}
 */
export async function sendSms({ to, template, data = {} }) {
  const ctx = getContext();
  const res = await notificationsService.notify({
    tenantId: ctx?.tenantId,
    branchId: ctx?.branchIds?.[0] || null,
    channel: 'sms',
    to,
    template,
    data,
    userId: ctx?.userId || null,
  });

  return {
    success: res.success !== false,
    messageId: String(res.messageId || res.logId || `sms-${Date.now()}`),
  };
}

export default { sendSms };
