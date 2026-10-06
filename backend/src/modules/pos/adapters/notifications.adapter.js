// TEMP: replace with Developer 5's service

/**
 * Sends an SMS to a customer phone number (logging stub until Dev 5's notification service arrives in week 8).
 *
 * @param {{ to: string, template: string, data?: object }} params
 * @returns {Promise<{ success: boolean, messageId: string }>}
 */
export async function sendSms({ to, template, data = {} }) {
  console.log(`[Notification SMS STUB] To: ${to} | Template: ${template} | Data:`, JSON.stringify(data));
  return {
    success: true,
    messageId: `stub-sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export default { sendSms };
