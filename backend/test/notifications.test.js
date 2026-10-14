import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import NotificationLog from '../src/modules/notifications/models/NotificationLog.model.js';
import NotificationTemplate from '../src/modules/notifications/models/NotificationTemplate.model.js';
import InAppNotification from '../src/modules/notifications/models/InAppNotification.model.js';
import { notify, renderTemplate } from '../src/modules/notifications/services/notifications.service.js';
import { processQueue, processItem } from '../src/modules/notifications/services/notifications.worker.js';
import { calculateSmsParts, isUnicodeText } from '../src/modules/notifications/utils/smsCounter.js';
import { maskPhone, maskEmail } from '../src/modules/notifications/utils/mask.js';
import { buildWhatsAppLink } from '../src/modules/notifications/utils/whatsapp.js';
import { setSmsProvider, setEmailProvider, resetProviders } from '../src/modules/notifications/providers/provider.interface.js';
import { forgotPassword } from '../src/modules/auth/auth.service.js';
import { sendLowStockAlert, sendSupplierPaymentReminder } from '../src/modules/inventory/adapters/notifications.adapter.js';
import User from '../src/modules/users/User.model.js';
import Role from '../src/modules/roles/Role.model.js';
import Branch from '../src/modules/branches/Branch.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  resetProviders();
  await resetDb();
});

describe('Notification Service (F-18 Phase 1)', () => {
  it('calculates SMS parts correctly for GSM and Unicode text', () => {
    // GSM single part: up to 160 chars
    const gsm160 = 'a'.repeat(160);
    expect(calculateSmsParts(gsm160)).toBe(1);

    // GSM multi-part: 153 chars per part
    const gsm161 = 'a'.repeat(161);
    expect(calculateSmsParts(gsm161)).toBe(2);

    const gsm306 = 'a'.repeat(306); // 153 * 2
    expect(calculateSmsParts(gsm306)).toBe(2);

    const gsm307 = 'a'.repeat(307);
    expect(calculateSmsParts(gsm307)).toBe(3);

    // Unicode single part: up to 70 chars (e.g. Sinhala)
    const sinhalaText70 = 'ආ'.repeat(70);
    expect(isUnicodeText(sinhalaText70)).toBe(true);
    expect(calculateSmsParts(sinhalaText70)).toBe(1);

    // Unicode multi-part: 67 chars per part
    const sinhalaText71 = 'ආ'.repeat(71);
    expect(calculateSmsParts(sinhalaText71)).toBe(2);

    const sinhalaText134 = 'ආ'.repeat(134); // 67 * 2
    expect(calculateSmsParts(sinhalaText134)).toBe(2);

    const sinhalaText135 = 'ආ'.repeat(135);
    expect(calculateSmsParts(sinhalaText135)).toBe(3);
  });

  it('masks sensitive phone numbers and emails', () => {
    expect(maskPhone('+94771234567')).toBe('+947*****567');
    expect(maskEmail('customer@cellivo.lk')).toBe('c******r@cellivo.lk');
    expect(maskEmail('ab@test.com')).toBe('a*@test.com');
  });

  it('builds wa.me link with prefilled text and cleaned phone', () => {
    const link = buildWhatsAppLink('+94 77 123-4567', 'Hello from Cellivo!');
    expect(link).toBe('https://wa.me/94771234567?text=Hello%20from%20Cellivo!');
  });

  it('renders merge fields with {customer_name} as standard field', () => {
    const rendered = renderTemplate('Hi {customer_name}, your bill is {amount}.', {
      customer_name: 'Kamal Perera',
      amount: 'Rs 1,500',
    });
    expect(rendered).toBe('Hi Kamal Perera, your bill is Rs 1,500.');
  });

  it('sends pre-tenant emails directly without creating NotificationLog', async () => {
    const res = await notify({
      tenantId: null,
      channel: 'email',
      to: 'prospective@cellivo.lk',
      template: 'signup_verification',
      data: { code: '849201', customer_name: 'New Owner' },
    });

    expect(res.success).toBe(true);
    expect(res.direct).toBe(true);

    const logCount = await runAsPlatform(async () => NotificationLog.countDocuments());
    expect(logCount).toBe(0);
  });

  it('rolls back queued notification if caller database transaction aborts', async () => {
    const shop = await signup('trx@shop.lk', 'Transaction Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    const session = await mongoose.startSession();
    session.startTransaction();

    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'sale_completed',
      data: { customer_name: 'Test Customer', invoice_no: 'INV-001', amount: 'Rs 1,000' },
      session,
    });

    // Abort transaction
    await session.abortTransaction();
    await session.endSession();

    // Verify NotificationLog was rolled back
    const count = await runWithContext({ tenantId }, async () => NotificationLog.countDocuments());
    expect(count).toBe(0);

    // Queue worker finds 0 items
    const processed = await processQueue();
    expect(processed).toBe(0);
  });

  it('deducts SMS credits atomically when worker sends', async () => {
    const shop = await signup('credits@shop.lk', 'Credits Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    // Grant 5 credits
    await runAsPlatform(async () => Tenant.updateOne({ _id: tenantId }, { smsCredits: 5 }));

    // Enqueue 1-part SMS (160 chars)
    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'sale_completed',
      data: { customer_name: 'Kasun', invoice_no: 'INV-101', amount: 'Rs 2,500' },
    });

    const processed = await processQueue();
    expect(processed).toBe(1);

    const updatedTenant = await runAsPlatform(async () => Tenant.findById(tenantId));
    expect(updatedTenant.smsCredits).toBe(4);

    const log = await runWithContext({ tenantId }, async () => NotificationLog.findOne({ status: 'sent' }));
    expect(log).toBeTruthy();
    expect(log.creditsDeducted).toBe(1);
    expect(log.status).toBe('sent');
  });

  it('deducts multi-part credits correctly (2 parts for 161 GSM chars)', async () => {
    const shop = await signup('multipart@shop.lk', 'Multi Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    await runAsPlatform(async () => Tenant.updateOne({ _id: tenantId }, { smsCredits: 10 }));

    const longMessage = 'This is a long SMS notification from Cellivo shop. '.repeat(4); // > 161 chars
    expect(calculateSmsParts(longMessage)).toBe(2);

    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: longMessage,
    });

    await processQueue();

    const updatedTenant = await runAsPlatform(async () => Tenant.findById(tenantId));
    expect(updatedTenant.smsCredits).toBe(8); // 10 - 2

    const log = await runWithContext({ tenantId }, async () => NotificationLog.findOne({ status: 'sent' }));
    expect(log.creditsDeducted).toBe(2);
    expect(log.partsCount).toBe(2);
  });

  it('marks log failed with NO_SMS_CREDITS and creates warning in-app notification when credits are 0', async () => {
    const shop = await signup('nocredits@shop.lk', 'Zero Credits Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    // Tenant starts with 0 smsCredits
    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'sale_completed',
      data: { customer_name: 'No Credit Customer' },
    });

    await processQueue();

    const log = await runWithContext({ tenantId }, async () => NotificationLog.findOne());
    expect(log.status).toBe('failed');
    expect(log.errorReason).toBe('NO_SMS_CREDITS');

    // Check warning in-app notification
    const inApp = await runWithContext({ tenantId }, async () =>
      InAppNotification.findOne({ level: 'warning' })
    );
    expect(inApp).toBeTruthy();
    expect(inApp.body).toContain('SMS not sent: no credits left');
  });

  it('retries with backoff and refunds credits upon final failure', async () => {
    const shop = await signup('retry@shop.lk', 'Retry Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    await runAsPlatform(async () => Tenant.updateOne({ _id: tenantId }, { smsCredits: 5 }));

    // Mock failing provider
    setSmsProvider({
      async send() {
        throw new Error('Gateway network timeout');
      },
    });

    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'sale_completed',
      data: { customer_name: 'Retry Customer' },
    });

    // First attempt: fails and schedules retry
    await processQueue();

    let log = await runWithContext({ tenantId }, async () => NotificationLog.findOne().select('+payload'));
    expect(log.status).toBe('queued');
    expect(log.retryCount).toBe(1);
    expect(log.errorReason).toBe('Gateway network timeout');
    expect(log.nextRetryAt > new Date()).toBe(true);

    // Tenant credits deducted during retry window
    let tenant = await runAsPlatform(async () => Tenant.findById(tenantId));
    expect(tenant.smsCredits).toBe(4);

    // Simulate reaching maxRetries (item at maxRetries - 1)
    log.retryCount = 2; // Next will be 3 (maxRetries)
    log.maxRetries = 3;
    log.nextRetryAt = new Date(Date.now() - 1000); // Ready now
    await runWithContext({ tenantId }, async () => log.save());

    // Final failure processing
    await processQueue();

    log = await runWithContext({ tenantId }, async () => NotificationLog.findOne());
    expect(log.status).toBe('failed');
    expect(log.retryCount).toBe(3);

    // Credits refunded!
    tenant = await runAsPlatform(async () => Tenant.findById(tenantId));
    expect(tenant.smsCredits).toBe(5);
  });

  it('respects marketing opt-out for promotional notifications', async () => {
    const shop = await signup('promo@shop.lk', 'Promo Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    const res = await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'loyalty_points_expiring',
      isPromotional: true,
      data: { marketingConsent: false },
    });

    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('MARKETING_OPT_OUT');

    const logCount = await runWithContext({ tenantId }, async () => NotificationLog.countDocuments());
    expect(logCount).toBe(0);
  });

  it('manages in-app notifications and mark-read lifecycle over HTTP', async () => {
    const shop = await signup('inapp@shop.lk', 'InApp Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;
    const userId = me._id;

    // Dispatch in-app notification
    await notify({
      tenantId,
      channel: 'in_app',
      to: '',
      template: 'repair_overdue',
      userId,
      data: { ticket_no: 'REP-101', customer_name: 'Sunil' },
    });

    await processQueue();

    // Check list
    const listRes = await api('get', '/api/notifications/in-app', shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);
    expect(listRes.body.unreadCount).toBe(1);

    const notifId = listRes.body.data[0]._id;

    // Mark single as read
    const readRes = await api('patch', `/api/notifications/in-app/${notifId}/read`, shop.token);
    expect(readRes.status).toBe(200);
    expect(readRes.body.data.readAt).toBeTruthy();

    // Check unread count is now 0
    const listAfter = await api('get', '/api/notifications/in-app?unread=true', shop.token);
    expect(listAfter.body.data.length).toBe(0);
    expect(listAfter.body.unreadCount).toBe(0);
  });

  it('updates template with audit logging and lists logs over HTTP', async () => {
    const shop = await signup('tpl@shop.lk', 'Template Shop');

    // List templates (merges defaults)
    const listRes = await api('get', '/api/notifications/templates', shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((t) => t.event === 'sale_completed')).toBe(true);

    // Update template
    const updateRes = await api('put', '/api/notifications/templates/sale_completed/sms', shop.token).send({
      body: 'Custom receipt for {customer_name}: invoice {invoice_no}',
      isActive: true,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.body).toContain('Custom receipt for {customer_name}');

    // Verify audit log
    const auditRes = await api('get', '/api/audit?action=notification_template.update', shop.token);
    expect(auditRes.body.data.length).toBeGreaterThan(0);
    expect(auditRes.body.data[0].action).toBe('notification_template.update');
  });

  it('enforces tenant isolation across notification logs and templates', async () => {
    const a = await signup('isota@shop.lk', 'Shop A');
    const b = await signup('isotb@shop.lk', 'Shop B');
    const tidA = (await api('get', '/api/auth/me', a.token)).body.data.tenant._id;

    // Shop A creates custom template and gets a log
    await api('put', '/api/notifications/templates/sale_completed/sms', a.token).send({
      body: 'Shop A custom template',
    });

    await notify({
      tenantId: tidA,
      channel: 'sms',
      to: '+94770000000',
      template: 'sale_completed',
      data: { customer_name: 'Secret Person' },
    });

    const logsA = (await api('get', '/api/notifications/logs', a.token)).body.data;
    expect(logsA.length).toBe(1);
    const logAId = logsA[0]._id;

    // Shop B cannot see Shop A's logs
    const logsB = (await api('get', '/api/notifications/logs', b.token)).body.data;
    expect(logsB.length).toBe(0);

    // Shop B cannot resend Shop A's log (returns 404)
    const resendRes = await api('post', `/api/notifications/logs/${logAId}/resend`, b.token);
    expect(resendRes.status).toBe(404);
  });

  it('claims queued item atomically so concurrent processQueue calls invoke provider once and deduct credits once', async () => {
    const shop = await signup('concurrent@shop.lk', 'Concurrent Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    await runAsPlatform(async () => Tenant.updateOne({ _id: tenantId }, { smsCredits: 10 }));

    let sendCallCount = 0;
    setSmsProvider({
      async send() {
        sendCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { success: true, messageId: 'sms_concurrent' };
      },
    });

    await notify({
      tenantId,
      channel: 'sms',
      to: '+94771234567',
      template: 'sale_completed',
      data: { customer_name: 'Concurrent Customer' },
    });

    // Run processQueue twice concurrently
    const [res1, res2] = await Promise.all([processQueue(), processQueue()]);

    expect(sendCallCount).toBe(1);
    expect(res1 + res2).toBe(1);

    const updatedTenant = await runAsPlatform(async () => Tenant.findById(tenantId));
    expect(updatedTenant.smsCredits).toBe(9); // exactly 1 credit deducted

    const log = await runWithContext({ tenantId }, async () => NotificationLog.findOne());
    expect(log.status).toBe('sent');
    expect(log.creditsDeducted).toBe(1);
  });

  it('resets items stuck in sending for > 5 minutes back to queued', async () => {
    const shop = await signup('stuck@shop.lk', 'Stuck Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    await runAsPlatform(async () => Tenant.updateOne({ _id: tenantId }, { smsCredits: 5 }));

    await runWithContext({ tenantId }, async () => {
      await NotificationLog.create({
        channel: 'sms',
        recipient: '+947*****567',
        payload: { to: '+94771234567', body: 'Stuck SMS' },
        template: 'custom',
        body: 'Stuck SMS',
        status: 'sending',
        lockedAt: new Date(Date.now() - 6 * 60 * 1000),
      });
    });

    const processed = await processQueue();
    expect(processed).toBe(1);

    const log = await runWithContext({ tenantId }, async () => NotificationLog.findOne());
    expect(log.status).toBe('sent');
  });

  it('does not store password reset links or tokens in NotificationLog, and logs API never returns tokens', async () => {
    const shop = await signup('resetlog@shop.lk', 'Reset Log Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    let sentEmail = null;
    setEmailProvider({
      async send(payload) {
        sentEmail = payload;
        return { success: true, messageId: 'email_reset_direct' };
      },
    });

    const token = await forgotPassword('resetlog@shop.lk');
    expect(token).toBeTruthy();
    // forgotPassword does not await notify, yield to allow background dispatch
    await new Promise((r) => setTimeout(r, 50));
    expect(sentEmail).toBeTruthy();
    expect(sentEmail.text).toContain(token);

    // No log entry created in NotificationLog
    const logsCount = await runWithContext({ tenantId }, async () => NotificationLog.countDocuments());
    expect(logsCount).toBe(0);

    // Logs API never returns the reset token
    const logsRes = await api('get', '/api/notifications/logs', shop.token);
    expect(logsRes.status).toBe(200);
    expect(JSON.stringify(logsRes.body)).not.toContain(token);
  });

  it('escapes merge-field values when building email HTML version', async () => {
    let capturedEmail = null;
    setEmailProvider({
      async send(payload) {
        capturedEmail = payload;
        return { success: true, messageId: 'email_escaped' };
      },
    });

    await notify({
      tenantId: null,
      channel: 'email',
      to: 'escape@cellivo.lk',
      template: 'Hello {customer_name},\nWelcome!',
      data: { customer_name: '<script>alert("xss")</script> & Co' },
    });

    expect(capturedEmail).toBeTruthy();
    expect(capturedEmail.text).toContain('<script>alert("xss")</script> & Co');
    expect(capturedEmail.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Co');
    expect(capturedEmail.html).not.toContain('<script>');
  });

  it('creates at most one NO_SMS_CREDITS in-app warning per tenant per day', async () => {
    const shop = await signup('dailywarn@shop.lk', 'Daily Warning Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    // Zero credits. Enqueue 3 SMS messages.
    for (let i = 1; i <= 3; i++) {
      await notify({
        tenantId,
        channel: 'sms',
        to: `+9477000000${i}`,
        template: 'sale_completed',
        data: { customer_name: `Customer ${i}` },
      });
    }

    const processed = await processQueue();
    expect(processed).toBe(3);

    // Exactly 1 warning in-app notification should exist
    const warnings = await runWithContext({ tenantId }, async () =>
      InAppNotification.find({ level: 'warning', title: 'SMS Delivery Failed' })
    );
    expect(warnings.length).toBe(1);
  });

  it('validates saveTemplate event, language, and character limits', async () => {
    const shop = await signup('valtmpl@shop.lk', 'Val Template Shop');

    // Invalid event
    const badEvent = await api('put', '/api/notifications/templates/nonexistent_event/sms', shop.token).send({
      body: 'Hello',
    });
    expect(badEvent.status).toBe(400);

    // Invalid language
    const badLang = await api('put', '/api/notifications/templates/sale_completed/sms', shop.token).send({
      body: 'Hello',
      language: 'fr',
    });
    expect(badLang.status).toBe(400);

    // SMS body > 1000 chars
    const tooLongSms = await api('put', '/api/notifications/templates/sale_completed/sms', shop.token).send({
      body: 'a'.repeat(1001),
      language: 'en',
    });
    expect(tooLongSms.status).toBe(400);

    // Email body > 10000 chars
    const tooLongEmail = await api('put', '/api/notifications/templates/sale_completed/email', shop.token).send({
      body: 'a'.repeat(10001),
      language: 'en',
    });
    expect(tooLongEmail.status).toBe(400);

    // Valid update
    const valid = await api('put', '/api/notifications/templates/sale_completed/sms', shop.token).send({
      body: 'Valid SMS message',
      language: 'si',
    });
    expect(valid.status).toBe(200);
  });

  it('audits resendLog and allows status=sending in the logs filter', async () => {
    const shop = await signup('auditresend@shop.lk', 'Audit Resend Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;

    // Create a failed log
    const failedLog = await runWithContext({ tenantId }, async () =>
      NotificationLog.create({
        channel: 'sms',
        recipient: '+947*****567',
        template: 'sale_completed',
        body: 'Failed message',
        status: 'failed',
        errorReason: 'NO_SMS_CREDITS',
      })
    );

    // Resend log
    const resendRes = await api('post', `/api/notifications/logs/${failedLog._id}/resend`, shop.token);
    expect(resendRes.status).toBe(200);

    // Check audit entry recorded
    const auditRes = await api('get', '/api/audit?action=notification_log.resend', shop.token);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data.length).toBeGreaterThan(0);
    expect(auditRes.body.data[0].action).toBe('notification_log.resend');

    // Create a sending log to test status=sending filter
    await runWithContext({ tenantId }, async () =>
      NotificationLog.create({
        channel: 'sms',
        recipient: '+947*****567',
        template: 'sale_completed',
        body: 'Sending message',
        status: 'sending',
        lockedAt: new Date(),
      })
    );

    const filterRes = await api('get', '/api/notifications/logs?status=sending', shop.token);
    expect(filterRes.status).toBe(200);
    expect(filterRes.body.data.some((l) => l.status === 'sending')).toBe(true);
  });

  it('sends in-app low_stock alert to owner and manager respecting branch isolation', async () => {
    const shop = await signup('stockalert@shop.lk', 'Stock Alert Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;
    const ownerUserId = me._id;

    // Create branch 2
    const branch2 = await runWithContext({ tenantId }, async () =>
      await Branch.create({ name: 'Branch 2', invoicePrefix: 'BR2', address: 'Kandy' })
    );
    const branch1Id = me.branchIds[0];
    const branch2Id = branch2._id;

    // Find branch_manager role
    const managerRole = await runWithContext({ tenantId }, async () =>
      await Role.findOne({ tenantId, key: 'branch_manager' })
    );

    // Create manager user assigned ONLY to branch 2
    const mgr2 = await runWithContext({ tenantId }, async () =>
      await User.create({
        name: 'Branch 2 Manager',
        email: 'mgr2@shop.lk',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
        roleId: managerRole._id,
        branchIds: [branch2Id],
        isActive: true,
      })
    );

    // Trigger low stock alert for branch 1
    const res = await sendLowStockAlert({
      tenantId,
      branchId: branch1Id,
      productId: new mongoose.Types.ObjectId(),
      productName: 'iPhone 13 Screen',
      currentQty: 2,
      reorderLevel: 5,
    });
    expect(res.success).toBe(true);
    // Owner has view_all_branches so receives it; mgr2 is only branch2 so should NOT receive it
    expect(res.count).toBe(1);

    await processQueue();

    const ownerNotifs = await runWithContext({ tenantId }, async () =>
      await InAppNotification.find({ tenantId, userId: ownerUserId }).lean()
    );
    expect(ownerNotifs.length).toBe(1);
    expect(ownerNotifs[0].title).toBe('Low Stock Alert');
    expect(ownerNotifs[0].body).toContain('iPhone 13 Screen');
    expect(ownerNotifs[0].body).toContain('2 units');

    const mgrNotifs = await runWithContext({ tenantId }, async () =>
      await InAppNotification.find({ tenantId, userId: mgr2._id }).lean()
    );
    expect(mgrNotifs.length).toBe(0);
  });

  it('sends supplier_payment_reminder in-app notification to owner and manager', async () => {
    const shop = await signup('suppalert@shop.lk', 'Supplier Alert Shop');
    const me = (await api('get', '/api/auth/me', shop.token)).body.data;
    const tenantId = me.tenant._id;
    const ownerUserId = me._id;

    const res = await sendSupplierPaymentReminder({
      tenantId,
      supplierId: new mongoose.Types.ObjectId(),
      supplierName: 'Apple Lanka',
      billNumber: 'BILL-909',
      amountCents: 15000000,
      dueDate: '2026-11-01',
    });
    expect(res.success).toBe(true);
    expect(res.count).toBeGreaterThanOrEqual(1);

    await processQueue();

    const notifs = await runWithContext({ tenantId }, async () =>
      await InAppNotification.find({ tenantId, userId: ownerUserId }).lean()
    );
    const reminder = notifs.find((n) => n.title === 'Supplier Payment Due');
    expect(reminder).toBeTruthy();
    expect(reminder.body).toContain('Apple Lanka');
    expect(reminder.body).toContain('2026-11-01');
  });
});
