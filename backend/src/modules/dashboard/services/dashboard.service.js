import Invoice from '../../pos/models/Invoice.model.js';
import RepairTicket from '../../repairs/models/RepairTicket.model.js';
import Product from '../../inventory/models/Product.model.js';
import StockLevel from '../../inventory/models/StockLevel.model.js';
import CreditNote from '../../pos/models/CreditNote.model.js';

export function getPeriodRange(period = 'today') {
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);

  if (period === 'this_week') {
    const day = now.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday as start of week
    start.setDate(now.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'this_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    // 'today' default
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }

  return { start, end };
}

/**
 * Get aggregated dashboard metrics and lists for the given tenant and branch filter.
 */
export async function getDashboardData({ tenantId, branchFilter = {}, period = 'today', allowCostMargin = false }) {
  const { start, end } = getPeriodRange(period);

  // 1. Sales in period (settled POS invoices)
  const salesFilter = {
    status: { $in: ['completed', 'partially_returned', 'returned'] },
    createdAt: { $gte: start, $lte: end },
    ...branchFilter,
  };
  const periodInvoices = await Invoice.find(salesFilter)
    .select('grandTotalCents createdAt invoiceNumber')
    .lean();

  const salesTotalCents = periodInvoices.reduce((sum, inv) => sum + (inv.grandTotalCents || 0), 0);
  const salesCount = periodInvoices.length;

  // 2. Active repairs count
  const activeStages = [
    'Received',
    'Diagnosing',
    'Waiting approval',
    'Waiting parts',
    'In repair',
    'Quality check',
  ];
  const activeRepairsFilter = {
    isArchived: false,
    stage: { $in: activeStages },
    ...branchFilter,
  };
  const activeRepairsCount = await RepairTicket.countDocuments(activeRepairsFilter);

  // 3. Low stock items count (stock <= reorderLevel, where reorderLevel > 0)
  const lowStockProducts = await Product.find({
    isArchived: false,
    reorderLevel: { $gt: 0 },
  })
    .select('_id name reorderLevel')
    .lean();

  let lowStockCount = 0;
  if (lowStockProducts.length > 0) {
    const productIds = lowStockProducts.map((p) => p._id);
    const stockLevels = await StockLevel.find({
      productId: { $in: productIds },
      ...branchFilter,
    }).lean();

    const stockMap = new Map();
    for (const sl of stockLevels) {
      const key = String(sl.productId);
      stockMap.set(key, (stockMap.get(key) || 0) + (sl.qty || 0));
    }

    for (const prod of lowStockProducts) {
      const currentQty = stockMap.get(String(prod._id)) || 0;
      if (currentQty <= prod.reorderLevel) {
        lowStockCount++;
      }
    }
  }

  // 4. Pending customer receivables (unpaid invoice balances + outstanding credit notes)
  const unpaidFilter = {
    status: { $ne: 'voided' },
    paymentStatus: { $in: ['unpaid', 'partially_paid', 'overdue'] },
    ...branchFilter,
  };
  const unpaidInvoices = await Invoice.find(unpaidFilter)
    .select('grandTotalCents totalPaidCents invoiceNumber customerId')
    .lean();

  const unpaidInvoicesCents = unpaidInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotalCents || 0) - (inv.totalPaidCents || 0)),
    0
  );

  const creditNotes = await CreditNote.find({ ...branchFilter })
    .select('totalRefundCents refundMethod creditNoteNumber')
    .lean();

  const creditNotesCents = creditNotes.reduce((sum, cn) => sum + (cn.totalRefundCents || 0), 0);

  // 5. Overdue repairs list (promisedDate < now and stage not terminal/ready)
  const overdueFilter = {
    isArchived: false,
    promisedDate: { $lt: new Date() },
    stage: { $nin: ['Ready', 'Delivered', 'Cancelled', 'Unrepairable'] },
    ...branchFilter,
  };

  const overdueDocs = await RepairTicket.find(overdueFilter)
    .sort({ promisedDate: 1 })
    .limit(10)
    .populate('customerId', 'name phone')
    .populate('technicianId', 'name')
    .lean();

  const overdueRepairs = overdueDocs.map((doc) => {
    const daysOverdue = Math.max(
      1,
      Math.ceil((Date.now() - new Date(doc.promisedDate).getTime()) / (1000 * 60 * 60 * 24))
    );
    return {
      id: doc._id,
      ticketNo: doc.ticketNo,
      customer: doc.customerId ? { name: doc.customerId.name, phone: doc.customerId.phone } : null,
      device: { brand: doc.device?.brand || '', model: doc.device?.model || '' },
      stage: doc.stage,
      promisedDate: doc.promisedDate,
      daysOverdue,
      technician: doc.technicianId?.name || null,
    };
  });

  // 6. Recent activity feed (last 10 events: sales, repair intakes, stage transitions)
  const recentInvoices = await Invoice.find({
    status: { $in: ['completed', 'partially_returned', 'returned'] },
    ...branchFilter,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .select('invoiceNumber grandTotalCents createdAt')
    .lean();

  const recentIntakes = await RepairTicket.find({
    isArchived: false,
    ...branchFilter,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .select('ticketNo device stage createdAt')
    .lean();

  const recentStageTickets = await RepairTicket.find({
    isArchived: false,
    'history.1': { $exists: true },
    ...branchFilter,
  })
    .sort({ updatedAt: -1 })
    .limit(10)
    .select('ticketNo history device updatedAt')
    .lean();

  const events = [];

  for (const inv of recentInvoices) {
    events.push({
      type: 'sale',
      title: `Sale Completed (${inv.invoiceNumber})`,
      description: `POS Invoice ${inv.invoiceNumber}`,
      amountCents: inv.grandTotalCents,
      timestamp: inv.createdAt,
      referenceId: inv._id,
    });
  }

  for (const r of recentIntakes) {
    events.push({
      type: 'repair_intake',
      title: `Repair Intake (${r.ticketNo})`,
      description: `${r.device?.brand || ''} ${r.device?.model || ''} received`,
      timestamp: r.createdAt,
      referenceId: r._id,
    });
  }

  for (const st of recentStageTickets) {
    if (Array.isArray(st.history) && st.history.length > 1) {
      const latest = st.history[st.history.length - 1];
      events.push({
        type: 'repair_stage',
        title: `Repair Stage Changed (${st.ticketNo})`,
        description: `${st.ticketNo} moved to ${latest.to}`,
        timestamp: latest.at || st.updatedAt,
        referenceId: st._id,
      });
    }
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const recentActivity = events.slice(0, 10);

  return {
    period,
    dateRange: { start, end },
    sales: {
      totalCents: salesTotalCents,
      count: salesCount,
    },
    activeRepairsCount,
    lowStockCount,
    receivables: {
      totalCents: unpaidInvoicesCents + creditNotesCents,
      unpaidInvoicesCents,
      creditNotesCents,
      unpaidInvoicesCount: unpaidInvoices.length,
      creditNotesCount: creditNotes.length,
    },
    overdueRepairs,
    recentActivity,
  };
}
