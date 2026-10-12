// TEMP: replace with Developer 5's service

/**
 * Send low-stock alert notification.
 */
export async function sendLowStockAlert({ tenantId, branchId, productId, productName, currentQty, reorderLevel }) {
  console.log(`[LowStockAlert] Tenant: ${tenantId}, Branch: ${branchId}, Product: ${productName} (${productId}), Qty: ${currentQty}, ReorderLevel: ${reorderLevel}`);
  return { success: true };
}

/**
 * Send supplier payment reminder notification.
 */
export async function sendSupplierPaymentReminder({ tenantId, supplierId, supplierName, billNumber, amountCents, dueDate }) {
  console.log(`[SupplierPaymentReminder] Tenant: ${tenantId}, Supplier: ${supplierName} (${supplierId}), Bill: ${billNumber}, Amount: ${amountCents}, Due: ${dueDate}`);
  return { success: true };
}

export default {
  sendLowStockAlert,
  sendSupplierPaymentReminder,
};
