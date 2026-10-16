import { runWithContext } from '../../../core/tenantContext.js';
import User from '../../users/User.model.js';
import Role from '../../roles/Role.model.js';
import { hasSpecial } from '../../../core/permissions.js';
import { notify } from '../../notifications/services/notifications.service.js';
import InAppNotification from '../../notifications/models/InAppNotification.model.js';
import NotificationLog from '../../notifications/models/NotificationLog.model.js';
import { formatRupees } from '../../pos/money.js';

/**
 * Find active users of the tenant who are shop owners or have inventory.edit permission,
 * respecting branch limits if branchId is provided.
 */
async function findRecipients(tenantId, branchId = null) {
  return await runWithContext({ tenantId }, async () => {
    const roles = await Role.find({
      tenantId,
      $or: [{ key: 'owner' }, { 'grid.inventory.edit': true }],
    }).lean();

    if (!roles || roles.length === 0) return [];

    const roleIds = roles.map((r) => r._id);
    const roleMap = new Map(roles.map((r) => [String(r._id), r]));

    const users = await User.find({
      tenantId,
      isActive: true,
      roleId: { $in: roleIds },
    }).lean();

    return users.filter((u) => {
      if (!branchId) return true;
      const role = roleMap.get(String(u.roleId));
      if (hasSpecial(role, 'view_all_branches')) return true;
      return u.branchIds?.some((b) => String(b) === String(branchId));
    });
  });
}

/**
 * Send low-stock alert notification.
 */
export async function sendLowStockAlert({ tenantId, branchId, productId, productName, currentQty, reorderLevel }) {
  try {
    if (!tenantId) return { success: false, reason: 'TENANT_REQUIRED' };

    const recipients = await findRecipients(tenantId, branchId);
    if (!recipients.length) return { success: true, count: 0 };

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const data = {
      item_name: productName,
      product_name: productName,
      quantity: currentQty,
      currentQty,
      reorder_level: reorderLevel,
      reorderLevel,
      productId: productId ? String(productId) : '',
      branchId: branchId ? String(branchId) : null,
    };

    let sentCount = 0;
    for (const user of recipients) {
      // Dedupe: check if unread InAppNotification or queued NotificationLog exists from the last 24 hours
      const isDuplicate = await runWithContext({ tenantId }, async () => {
        const unreadInApp = await InAppNotification.findOne({
          tenantId,
          userId: user._id,
          readAt: null,
          createdAt: { $gte: since },
          'data.productId': String(productId),
          'data.branchId': branchId ? String(branchId) : null,
        }).lean();
        if (unreadInApp) return true;

        const queuedLog = await NotificationLog.findOne({
          tenantId,
          userId: user._id,
          channel: 'in_app',
          template: 'low_stock',
          status: { $in: ['queued', 'sending'] },
          createdAt: { $gte: since },
          'data.productId': String(productId),
          'data.branchId': branchId ? String(branchId) : null,
        }).lean();
        return !!queuedLog;
      });

      if (isDuplicate) {
        continue;
      }

      await notify({
        tenantId,
        branchId: branchId || null,
        channel: 'in_app',
        to: `user:${user._id}`,
        userId: user._id,
        template: 'low_stock',
        data,
        session: null,
      });
      sentCount++;
    }

    return { success: true, count: sentCount };
  } catch (err) {
    console.error('[inventory notify]', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send supplier payment reminder notification.
 */
export async function sendSupplierPaymentReminder({ tenantId, supplierId, supplierName, billNumber, amountCents, dueDate }) {
  try {
    if (!tenantId) return { success: false, reason: 'TENANT_REQUIRED' };

    const recipients = await findRecipients(tenantId, null);
    if (!recipients.length) return { success: true, count: 0 };

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const formattedDueDate = dueDate instanceof Date
      ? dueDate.toISOString().split('T')[0]
      : (typeof dueDate === 'string' ? dueDate.split('T')[0] : String(dueDate || ''));

    const formattedAmount = formatRupees(amountCents || 0);
    const data = {
      supplier_name: supplierName || 'Unknown Supplier',
      supplierName: supplierName || 'Unknown Supplier',
      bill_number: billNumber || '',
      billNumber: billNumber || '',
      amount: formattedAmount,
      amountCents: amountCents || 0,
      due_date: formattedDueDate,
      dueDate: formattedDueDate,
      supplierId: supplierId ? String(supplierId) : '',
    };

    let sentCount = 0;
    for (const user of recipients) {
      // Dedupe: check if unread InAppNotification or queued NotificationLog exists from the last 24 hours
      const isDuplicate = await runWithContext({ tenantId }, async () => {
        const unreadInApp = await InAppNotification.findOne({
          tenantId,
          userId: user._id,
          readAt: null,
          createdAt: { $gte: since },
          'data.supplierId': String(supplierId),
          'data.billNumber': String(billNumber),
        }).lean();
        if (unreadInApp) return true;

        const queuedLog = await NotificationLog.findOne({
          tenantId,
          userId: user._id,
          channel: 'in_app',
          template: 'supplier_payment_reminder',
          status: { $in: ['queued', 'sending'] },
          createdAt: { $gte: since },
          'data.supplierId': String(supplierId),
          'data.billNumber': String(billNumber),
        }).lean();
        return !!queuedLog;
      });

      if (isDuplicate) {
        continue;
      }

      await notify({
        tenantId,
        branchId: null,
        channel: 'in_app',
        to: `user:${user._id}`,
        userId: user._id,
        template: 'supplier_payment_reminder',
        data,
        session: null,
      });
      sentCount++;
    }

    return { success: true, count: sentCount };
  } catch (err) {
    console.error('[inventory notify]', err.message);
    return { success: false, error: err.message };
  }
}

export default {
  sendLowStockAlert,
  sendSupplierPaymentReminder,
};
