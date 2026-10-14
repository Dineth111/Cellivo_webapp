import { authFetch } from './api.js';

// Query string helper
function qs(params = {}) {
  const filtered = Object.entries(params).filter(([_, v]) => v !== undefined && v !== null && v !== '');
  if (filtered.length === 0) return '';
  return '?' + new URLSearchParams(filtered).toString();
}

// ==========================================
// PRODUCTS & CATALOGUE
// ==========================================
export const listProducts = (params) => authFetch(`/inventory/products${qs(params)}`);
export const getProduct = (id) => authFetch(`/inventory/products/${id}`);
export const createProduct = (data) => authFetch('/inventory/products', { method: 'POST', body: JSON.stringify(data) });
export const updateProduct = (id, data) => authFetch(`/inventory/products/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const archiveProduct = (id) => authFetch(`/inventory/products/${id}`, { method: 'DELETE' });

export const listCategories = () => authFetch('/inventory/categories');
export const createCategory = (data) => authFetch('/inventory/categories', { method: 'POST', body: JSON.stringify(data) });
export const listBrands = () => authFetch('/inventory/brands');
export const createBrand = (data) => authFetch('/inventory/brands', { method: 'POST', body: JSON.stringify(data) });
export const listModels = () => authFetch('/inventory/models');
export const createModel = (data) => authFetch('/inventory/models', { method: 'POST', body: JSON.stringify(data) });

// ==========================================
// STOCK LEVELS, ADJUSTMENTS & COUNTS
// ==========================================
export const listStockLevels = (params) => authFetch(`/inventory/stock-levels${qs(params)}`);
export const listMovements = (params) => authFetch(`/inventory/movements${qs(params)}`);
export const getLowStockItems = () => authFetch('/inventory/low-stock');

export const listAdjustments = (params) => authFetch(`/inventory/adjustments${qs(params)}`);
export const createAdjustment = (data) => authFetch('/inventory/adjustments', { method: 'POST', body: JSON.stringify(data) });

export const listStockCounts = (params) => authFetch(`/inventory/counts${qs(params)}`);
export const getStockCount = (id) => authFetch(`/inventory/counts/${id}`);
export const createStockCount = (data) => authFetch('/inventory/counts', { method: 'POST', body: JSON.stringify(data) });
export const updateStockCount = (id, data) => authFetch(`/inventory/counts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const approveStockCount = (id) => authFetch(`/inventory/counts/${id}/approve`, { method: 'POST' });

export const importProductsCsv = (csvText) => authFetch('/inventory/products/import-csv', { method: 'POST', body: JSON.stringify({ csv: csvText }) });

// ==========================================
// IMEI TRACKING
// ==========================================
export const searchImei = (query) => authFetch(`/inventory/imei/search${qs({ query })}`);
export const getImeiTimeline = (imei) => authFetch(`/inventory/imei/${encodeURIComponent(imei)}/timeline`);
export const reserveImei = (imei, data) => authFetch(`/inventory/imei/${encodeURIComponent(imei)}/reserve`, { method: 'POST', body: JSON.stringify(data) });
export const releaseImei = (imei) => authFetch(`/inventory/imei/${encodeURIComponent(imei)}/release`, { method: 'POST' });

// ==========================================
// BARCODES & LABELS
// ==========================================
export const generateBarcode = () => authFetch('/inventory/products/generate-barcode', { method: 'POST' });
export const assignBarcode = (productId, barcode) => authFetch(`/inventory/products/${productId}/assign-barcode`, { method: 'POST', body: JSON.stringify({ barcode }) });
export const getLabelPresets = () => authFetch('/inventory/labels/presets');
export const previewLabels = (data) => authFetch('/inventory/labels/preview', { method: 'POST', body: JSON.stringify(data) });

// ==========================================
// PURCHASING & SUPPLIERS
// ==========================================
export const listSuppliers = (params) => authFetch(`/inventory/suppliers${qs(params)}`);
export const getSupplier = (id) => authFetch(`/inventory/suppliers/${id}`);
export const createSupplier = (data) => authFetch('/inventory/suppliers', { method: 'POST', body: JSON.stringify(data) });
export const updateSupplier = (id, data) => authFetch(`/inventory/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const archiveSupplier = (id) => authFetch(`/inventory/suppliers/${id}`, { method: 'DELETE' });

export const listPurchaseOrders = (params) => authFetch(`/inventory/purchase-orders${qs(params)}`);
export const getPurchaseOrder = (id) => authFetch(`/inventory/purchase-orders/${id}`);
export const createPurchaseOrder = (data) => authFetch('/inventory/purchase-orders', { method: 'POST', body: JSON.stringify(data) });
export const updatePoStatus = (id, status) => authFetch(`/inventory/purchase-orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });

export const listGrns = (params) => authFetch(`/inventory/grns${qs(params)}`);
export const getGrn = (id) => authFetch(`/inventory/grns/${id}`);
export const createGrn = (data) => authFetch('/inventory/grns', { method: 'POST', body: JSON.stringify(data) });

export const listBills = (params) => authFetch(`/inventory/bills${qs(params)}`);
export const getBillsAgeing = (supplierId) => authFetch(`/inventory/bills/ageing${qs({ supplierId })}`);

export const listPayments = (params) => authFetch(`/inventory/payments${qs(params)}`);
export const createPayment = (data) => authFetch('/inventory/payments', { method: 'POST', body: JSON.stringify(data) });

export const listPurchaseReturns = (params) => authFetch(`/inventory/purchase-returns${qs(params)}`);
export const createPurchaseReturn = (data) => authFetch('/inventory/purchase-returns', { method: 'POST', body: JSON.stringify(data) });

// ==========================================
// STOCK TRANSFERS
// ==========================================
export const listTransfers = (params) => authFetch(`/inventory/transfers${qs(params)}`);
export const getTransfer = (id) => authFetch(`/inventory/transfers/${id}`);
export const requestTransfer = (data) => authFetch('/inventory/transfers', { method: 'POST', body: JSON.stringify(data) });
export const approveTransfer = (id) => authFetch(`/inventory/transfers/${id}/approve`, { method: 'POST' });
export const dispatchTransfer = (id, data) => authFetch(`/inventory/transfers/${id}/dispatch`, { method: 'POST', body: JSON.stringify(data) });
export const receiveTransfer = (id, data) => authFetch(`/inventory/transfers/${id}/receive`, { method: 'POST', body: JSON.stringify(data) });
export const cancelTransfer = (id, data) => authFetch(`/inventory/transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify(data) });
