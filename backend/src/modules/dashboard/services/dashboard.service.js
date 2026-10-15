import mongoose from 'mongoose';
import Invoice from '../../pos/models/Invoice.model.js';
import RepairTicket from '../../repairs/models/RepairTicket.model.js';
import Product from '../../inventory/models/Product.model.js';
import CreditNote from '../../pos/models/CreditNote.model.js';
import { hasPermission, hasSpecial } from '../../../core/permissions.js';

function toObjectId(id) {
  if (!id) return null;
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

/**
 * Calculates start and end Date for 'today', 'this_week', and 'this_month'
 * in Asia/Colombo timezone (UTC+5:30) where the week begins on Monday.
 */
export function getColomboPeriodRange(period = 'today', referenceDate = new Date()) {
  const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 330 minutes in ms
  const localTime = new Date(referenceDate.getTime() + COLOMBO_OFFSET_MS);

  const year = localTime.getUTCFullYear();
  const month = localTime.getUTCMonth();
  const date = localTime.getUTCDate();
  const day = localTime.getUTCDay(); // 0 is Sunday, 1 is Monday ... 6 is Saturday

  let startUtcMs;
  let endUtcMs;

  if (period === 'this_week') {
    // Week starts on Monday: Monday has 0 days diff, Sunday (0) has 6 days diff
    const diffToMonday = day === 0 ? 6 : day - 1;
    startUtcMs = Date.UTC(year, month, date - diffToMonday, 0, 0, 0, 0) - COLOMBO_OFFSET_MS;
    endUtcMs = Date.UTC(year, month, date - diffToMonday + 6, 23, 59, 59, 999) - COLOMBO_OFFSET_MS;
  } else if (period === 'this_month') {
    startUtcMs = Date.UTC(year, month, 1, 0, 0, 0, 0) - COLOMBO_OFFSET_MS;
    endUtcMs = Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - COLOMBO_OFFSET_MS;
  } else {
    // 'today' default
    startUtcMs = Date.UTC(year, month, date, 0, 0, 0, 0) - COLOMBO_OFFSET_MS;
    endUtcMs = Date.UTC(year, month, date, 23, 59, 59, 999) - COLOMBO_OFFSET_MS;
  }

  return {
    start: new Date(startUtcMs),
    end: new Date(endUtcMs),
  };
}

/**
 * Retrieves dashboard metrics with strict permission gating and tenant/branch isolation.
 * Every aggregation pipeline begins with a $match containing tenantId (and branchId if scoped).
 */
export async function getDashboardData({
  tenantId,
  branchId = null,
  period = 'today',
  role = null,
  referenceDate = new Date(),
}) {
  const tId = toObjectId(tenantId);
  const bId = branchId ? toObjectId(branchId) : null;
  const { start, end } = getColomboPeriodRange(period, referenceDate);

  // Permission checks per tile & activity feed
  const canViewSales = hasPermission(role, 'pos.view');
  const canViewRepairs = hasPermission(role, 'repairs.view');
  const canViewStock = hasPermission(role, 'inventory.view');
  const canViewReceivables = hasPermission(role, 'finance.view');

  // 1. Sales Metrics (Net sales = settled sales - returns within the period)
  let sales = null;
  if (canViewSales) {
    const salesMatch = {
      tenantId: tId,
      status: { $in: ['completed', 'partially_returned', 'returned'] },
      createdAt: { $gte: start, $lte: end },
    };
    if (bId) salesMatch.branchId = bId;

    const [salesAgg] = await Invoice.aggregate([
      { $match: salesMatch },
      {
        $group: {
          _id: null,
          grossCents: { $sum: '$grandTotalCents' },
          count: { $sum: 1 },
        },
      },
    ]);

    const returnsMatch = {
      tenantId: tId,
      createdAt: { $gte: start, $lte: end },
    };
    if (bId) returnsMatch.branchId = bId;

    const [returnsAgg] = await CreditNote.aggregate([
      { $match: returnsMatch },
      {
        $group: {
          _id: null,
          refundCents: { $sum: '$totalRefundCents' },
          count: { $sum: 1 },
        },
      },
    ]);

    const grossSalesCents = salesAgg?.grossCents || 0;
    const returnsCents = returnsAgg?.refundCents || 0;
    const netSalesCents = Math.max(0, grossSalesCents - returnsCents);

    sales = {
      totalCents: netSalesCents,
      grossCents: grossSalesCents,
      returnsCents,
      count: salesAgg?.count || 0,
    };
  }

  // 2. Active repairs count
  let activeRepairsCount = null;
  if (canViewRepairs) {
    const activeRepairsMatch = {
      tenantId: tId,
      isArchived: false,
      stage: {
        $in: [
          'Received',
          'Diagnosing',
          'Waiting approval',
          'Waiting parts',
          'In repair',
          'Quality check',
        ],
      },
    };
    if (bId) activeRepairsMatch.branchId = bId;

    const [activeAgg] = await RepairTicket.aggregate([
      { $match: activeRepairsMatch },
      { $count: 'count' },
    ]);
    activeRepairsCount = activeAgg?.count || 0;
  }

  // 3. Low stock count (Products where total branch stock <= reorderLevel, reorderLevel > 0)
  let lowStockCount = null;
  if (canViewStock) {
    const prodMatch = {
      tenantId: tId,
      isArchived: false,
      reorderLevel: { $gt: 0 },
    };

    const lowStockAgg = await Product.aggregate([
      { $match: prodMatch },
      {
        $lookup: {
          from: 'stocklevels',
          let: { pId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$tenantId', tId] },
                    ...(bId ? [{ $eq: ['$branchId', bId] }] : []),
                    { $eq: ['$productId', '$$pId'] },
                  ],
                },
              },
            },
          ],
          as: 'stockLevels',
        },
      },
      {
        $addFields: {
          totalQty: { $sum: '$stockLevels.qty' },
        },
      },
      {
        $match: {
          $expr: { $lte: ['$totalQty', '$reorderLevel'] },
        },
      },
      { $count: 'count' },
    ]);
    lowStockCount = lowStockAgg[0]?.count || 0;
  }

  // 4. Pending customer receivables (unpaid invoice balances only)
  let receivables = null;
  if (canViewReceivables) {
    const receivablesMatch = {
      tenantId: tId,
      status: { $ne: 'voided' },
      paymentStatus: { $in: ['unpaid', 'partially_paid', 'overdue'] },
    };
    if (bId) receivablesMatch.branchId = bId;

    const [recAgg] = await Invoice.aggregate([
      { $match: receivablesMatch },
      {
        $project: {
          dueCents: {
            $max: [0, { $subtract: ['$grandTotalCents', { $ifNull: ['$totalPaidCents', 0] }] }],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalDueCents: { $sum: '$dueCents' },
          count: { $sum: 1 },
        },
      },
    ]);

    receivables = {
      totalCents: recAgg?.totalDueCents || 0,
      unpaidInvoicesCents: recAgg?.totalDueCents || 0,
      count: recAgg?.count || 0,
    };
  }

  // 5. Overdue repairs list
  let overdueRepairs = null;
  if (canViewRepairs) {
    const overdueMatch = {
      tenantId: tId,
      isArchived: false,
      promisedDate: { $lt: new Date() },
      stage: { $nin: ['Ready', 'Delivered', 'Cancelled', 'Unrepairable'] },
    };
    if (bId) overdueMatch.branchId = bId;

    const overdueDocs = await RepairTicket.aggregate([
      { $match: overdueMatch },
      { $sort: { promisedDate: 1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'customers',
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerDoc',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'technicianId',
          foreignField: '_id',
          as: 'techDoc',
        },
      },
      {
        $project: {
          ticketNo: 1,
          device: 1,
          stage: 1,
          promisedDate: 1,
          customer: { $arrayElemAt: ['$customerDoc', 0] },
          technician: { $arrayElemAt: ['$techDoc', 0] },
        },
      },
    ]);

    const nowMs = Date.now();
    overdueRepairs = overdueDocs.map((doc) => {
      const daysOverdue = Math.max(
        1,
        Math.ceil((nowMs - new Date(doc.promisedDate).getTime()) / (1000 * 60 * 60 * 24))
      );
      return {
        id: doc._id,
        ticketNo: doc.ticketNo,
        customer: doc.customer ? { name: doc.customer.name, phone: doc.customer.phone } : null,
        device: { brand: doc.device?.brand || '', model: doc.device?.model || '' },
        stage: doc.stage,
        promisedDate: doc.promisedDate,
        daysOverdue,
        technician: doc.technician?.name || null,
      };
    });
  }

  // 6. Recent activity feed (filtered strictly by user permissions)
  const events = [];

  if (canViewSales) {
    const recentInvoices = await Invoice.aggregate([
      {
        $match: {
          tenantId: tId,
          status: { $in: ['completed', 'partially_returned', 'returned'] },
          ...(bId ? { branchId: bId } : {}),
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 10 },
      {
        $project: {
          invoiceNumber: 1,
          grandTotalCents: 1,
          createdAt: 1,
        },
      },
    ]);

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
  }

  if (canViewRepairs) {
    const recentIntakes = await RepairTicket.aggregate([
      {
        $match: {
          tenantId: tId,
          isArchived: false,
          ...(bId ? { branchId: bId } : {}),
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 10 },
      {
        $project: {
          ticketNo: 1,
          device: 1,
          stage: 1,
          createdAt: 1,
        },
      },
    ]);

    for (const r of recentIntakes) {
      events.push({
        type: 'repair_intake',
        title: `Repair Intake (${r.ticketNo})`,
        description: `${r.device?.brand || ''} ${r.device?.model || ''} received`,
        timestamp: r.createdAt,
        referenceId: r._id,
      });
    }

    const recentStageTickets = await RepairTicket.aggregate([
      {
        $match: {
          tenantId: tId,
          isArchived: false,
          'history.1': { $exists: true },
          ...(bId ? { branchId: bId } : {}),
        },
      },
      { $sort: { updatedAt: -1 } },
      { $limit: 10 },
      {
        $project: {
          ticketNo: 1,
          history: 1,
          device: 1,
          updatedAt: 1,
        },
      },
    ]);

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
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const recentActivity = events.slice(0, 10);

  return {
    period,
    dateRange: { start, end },
    sales,
    activeRepairsCount,
    lowStockCount,
    receivables,
    overdueRepairs,
    recentActivity,
  };
}
