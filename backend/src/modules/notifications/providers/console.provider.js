import { config } from '../../../core/config.js';

export const consoleSmsProvider = {
  /**
   * @param {{ to: string, message: string }} params
   * @returns {Promise<{ success: boolean, messageId: string }>}
   */
  async send({ to, message }) {
    if (config.env !== 'test') {
      console.log(`[SMS Provider] To: ${to} | Body: ${message}`);
    }
    return {
      success: true,
      messageId: `sms_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };
  },
};

export const consoleEmailProvider = {
  /**
   * @param {{ to: string, subject: string, text: string, html?: string }} params
   * @returns {Promise<{ success: boolean, messageId: string }>}
   */
  async send({ to, subject, text, html }) {
    if (config.env !== 'test') {
      console.log(`[Email Provider] To: ${to} | Subject: ${subject} | Body: ${text || html}`);
    }
    return {
      success: true,
      messageId: `email_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };
  },
};

export default { consoleSmsProvider, consoleEmailProvider };
