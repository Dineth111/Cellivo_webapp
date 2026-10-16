import mongoose from 'mongoose';
import Invoice from '../../pos/models/Invoice.model.js';
import CreditNote from '../../pos/models/CreditNote.model.js';
import Product from '../../inventory/models/Product.model.js';
import StockLevel from '../../inventory/models/StockLevel.model.js';
import RepairTicket from '../../repairs/models/RepairTicket.model.js';
import Branch from '../../branches/Branch.model.js';
import Customer from '../../customers/Customer.model.js';
import { badRequest } from '../../../core/errors.js';
import { parseColomboDateRange } from '../utils/dateUtils.js';
import { buildCsv } from '../utils/csvUtils.js';

export const REPAIR_STAGES = [
  'Received',
  'Diagnosing',
  'Waiting approval',
  'Waiting parts',
  'In repair',
  'Quality check',
  'Ready',
  'Delivered',
  'Unrepairable',
  'Cancelled',
];

export const ACTIVE_REPAIR_STAGES = [
  'Received',
  'Diagnosing',
  'Waiting approval',
  'Waiting parts',
  'In repair',
  'Quality check',
];

const parsePagination = (query) => {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) {
    throw badRequest('Pagination limit cannot exceed 200', 'LIMIT_EXCEEDED');
  }
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

function validateBranchId(branchId) {
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    if (!mongoose.isValidObjectId(String(branchId))) {
      throw badRequest('Invalid branchId', 'INVALID_BRANCH_ID');
    }
  }
}

/**
 * 1. Sales Report
 * Only completed, partially_returned, returned invoices.
 */
export async function getSalesReport({
  tenantId,
  branchId,
  startDate,
  endDate,
  query = {},
  viewCostMargin = false,
}) {
  validateBranchId(branchId);
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { start, end } = parseColomboDateRange(startDate, endDate);
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    status: { $in: ['completed', 'partially_returned', 'returned'] },
    createdAt: { $gte: start, $lte: end },
  };
  if (bId) matchFilter.branchId = bId;

  // Aggregate invoice metrics
  const invoiceAgg = await Invoice.aggregate([
    { $match: matchFilter },
    {
      $project: {
        grandTotalCents: 1,
        subtotalCents: 1,
        discountCents: 1,
        taxCents: 1,
        totalPaidCents: 1,
        lines: 1,
        invoiceCostCents: {
          $sum: {
            $map: {
              input: '$lines',
              as: 'l',
              in: { $multiply: [{ $ifNull: ['$$l.costPriceCents', 0] }, '$$l.qty'] },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        totalGrossCents: { $sum: '$grandTotalCents' },
        totalSubtotalCents: { $sum: '$subtotalCents' },
        totalDiscountCents: { $sum: '$discountCents' },
        totalTaxCents: { $sum: '$taxCents' },
        totalPaidCents: { $sum: '$totalPaidCents' },
        totalCostCents: { $sum: '$invoiceCostCents' },
      },
    },
  ]);

  // Aggregate credit notes (returns)
  const cnMatchFilter = {
    tenantId: tId,
    createdAt: { $gte: start, $lte: end },
  };
  if (bId) cnMatchFilter.branchId = bId;

  const returnAgg = await CreditNote.aggregate([
    { $match: cnMatchFilter },
    {
      $group: {
        _id: null,
        totalReturnsCount: { $sum: 1 },
        totalRefundCents: { $sum: '$totalRefundCents' },
      },
    },
  ]);

  const invSummary = invoiceAgg[0] || {
    totalInvoices: 0,
    totalGrossCents: 0,
    totalSubtotalCents: 0,
    totalDiscountCents: 0,
    totalTaxCents: 0,
    totalPaidCents: 0,
    totalCostCents: 0,
  };
  const retSummary = returnAgg[0] || { totalReturnsCount: 0, totalRefundCents: 0 };

  const netSalesCents = invSummary.totalGrossCents - retSummary.totalRefundCents;
  const grossProfitCents = viewCostMargin ? netSalesCents - invSummary.totalCostCents : null;
  const marginPercent =
    viewCostMargin && netSalesCents > 0
      ? Number(((grossProfitCents / netSalesCents) * 100).toFixed(2))
      : null;

  // Paginated records
  const totalCount = invSummary.totalInvoices;
  const totalPages = Math.ceil(totalCount / limit) || 1;

  const rawInvoices = await Invoice.aggregate([
    { $match: matchFilter },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: 'branches',
        localField: 'branchId',
        foreignField: '_id',
        as: 'branchDoc',
      },
    },
    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customerDoc',
      },
    },
    {
      $project: {
        invoiceNumber: 1,
        createdAt: 1,
        branchId: 1,
        branchName: { $ifNull: [{ $arrayElemAt: ['$branchDoc.name', 0] }, 'Main Branch'] },
        customerId: 1,
        customerName: {
          $ifNull: [
            '$customerSnapshot.name',
            { $ifNull: [{ $arrayElemAt: ['$customerDoc.name', 0] }, 'Walk-in Customer'] },
          ],
        },
        status: 1,
        paymentStatus: 1,
        subtotalCents: 1,
        discountCents: 1,
        grandTotalCents: 1,
        totalPaidCents: 1,
        linesCount: { $size: '$lines' },
        costCents: {
          $sum: {
            $map: {
              input: '$lines',
              as: 'l',
              in: { $multiply: [{ $ifNull: ['$$l.costPriceCents', 0] }, '$$l.qty'] },
            },
          },
        },
      },
    },
  ]);

  const items = rawInvoices.map((inv) => {
    const profitCents = viewCostMargin ? inv.grandTotalCents - inv.costCents : null;
    return {
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      createdAt: inv.createdAt,
      branchId: inv.branchId,
      branchName: inv.branchName,
      customerName: inv.customerName,
      status: inv.status,
      paymentStatus: inv.paymentStatus,
      grandTotalCents: inv.grandTotalCents,
      totalPaidCents: inv.totalPaidCents,
      balanceDueCents: Math.max(0, inv.grandTotalCents - inv.totalPaidCents),
      costCents: viewCostMargin ? inv.costCents : null,
      profitCents,
    };
  });

  return {
    summary: {
      period: { start, end },
      totalInvoices: invSummary.totalInvoices,
      grossSalesCents: invSummary.totalGrossCents,
      totalRefundsCents: retSummary.totalRefundCents,
      returnsCount: retSummary.totalReturnsCount,
      netSalesCents,
      totalCostCents: viewCostMargin ? invSummary.totalCostCents : null,
      grossProfitCents,
      marginPercent,
    },
    pagination: { page, limit, totalCount, totalPages },
    data: items,
  };
}

/**
 * 2. Inventory Valuation & Stock Report
 * Only products that track stock (trackStock !== false).
 * totalCostValue = sum over each stock level of (qty * averageCostCents).
 * isLowStock uses dashboard rule: (p.reorderLevel > 0 && totalQty <= p.reorderLevel).
 */
export async function getInventoryReport({
  tenantId,
  branchId,
  query = {},
  viewCostMargin = false,
}) {
  validateBranchId(branchId);
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    isArchived: false,
    trackStock: { $ne: false },
  };

  const pipeline = [
    { $match: matchFilter },
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
                  { $eq: ['$productId', '$$pId'] },
                  ...(bId ? [{ $eq: ['$branchId', bId] }] : []),
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
        totalQtyOnHand: { $sum: '$stockLevels.qty' },
        totalCostValueCents: {
          $cond: [
            { $gt: [{ $size: '$stockLevels' }, 0] },
            {
              $sum: {
                $map: {
                  input: '$stockLevels',
                  as: 'sl',
                  in: {
                    $multiply: [
                      { $ifNull: ['$$sl.qty', 0] },
                      { $ifNull: ['$$sl.averageCostCents', 0] },
                    ],
                  },
                },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        totalRetailValueCents: { $multiply: ['$totalQtyOnHand', '$sellingPriceCents'] },
        avgCostCents: {
          $cond: [
            { $gt: ['$totalQtyOnHand', 0] },
            { $divide: ['$totalCostValueCents', '$totalQtyOnHand'] },
            {
              $cond: [
                { $gt: [{ $size: '$stockLevels' }, 0] },
                { $avg: '$stockLevels.averageCostCents' },
                { $ifNull: ['$costPriceCents', 0] },
              ],
            },
          ],
        },
      },
    },
  ];

  // Summary aggregation
  const summaryAgg = await Product.aggregate([
    ...pipeline,
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        totalUnits: { $sum: '$totalQtyOnHand' },
        totalRetailValueCents: { $sum: '$totalRetailValueCents' },
        totalCostValueCents: { $sum: '$totalCostValueCents' },
      },
    },
  ]);

  const summary = summaryAgg[0] || {
    totalProducts: 0,
    totalUnits: 0,
    totalRetailValueCents: 0,
    totalCostValueCents: 0,
  };

  const totalCount = summary.totalProducts;
  const totalPages = Math.ceil(totalCount / limit) || 1;

  const rawProducts = await Product.aggregate([
    ...pipeline,
    { $sort: { name: 1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        name: 1,
        barcode: 1,
        sku: 1,
        sellingPriceCents: 1,
        totalQtyOnHand: 1,
        totalRetailValueCents: 1,
        avgCostCents: 1,
        totalCostValueCents: 1,
        reorderLevel: 1,
      },
    },
  ]);

  const items = rawProducts.map((p) => ({
    _id: p._id,
    name: p.name,
    barcode: p.barcode,
    sku: p.sku || '',
    sellingPriceCents: p.sellingPriceCents,
    qtyOnHand: p.totalQtyOnHand || 0,
    totalRetailValueCents: p.totalRetailValueCents || 0,
    averageCostCents: viewCostMargin ? Math.round(p.avgCostCents || 0) : null,
    totalCostValueCents: viewCostMargin ? Math.round(p.totalCostValueCents || 0) : null,
    isLowStock: Boolean(p.reorderLevel > 0 && (p.totalQtyOnHand || 0) <= p.reorderLevel),
  }));

  return {
    summary: {
      totalProducts: summary.totalProducts,
      totalUnits: summary.totalUnits,
      totalRetailValueCents: summary.totalRetailValueCents,
      totalCostValueCents: viewCostMargin ? Math.round(summary.totalCostValueCents) : null,
      potentialProfitCents: viewCostMargin
        ? Math.round(summary.totalRetailValueCents - summary.totalCostValueCents)
        : null,
    },
    pagination: { page, limit, totalCount, totalPages },
    data: items,
  };
}

/**
 * 3. Repairs Report
 * Uses real technician field: technicianId.
 * Validates stage against allowed enum (rejects non-strings/objects with 400).
 * Validates technicianId as ObjectId (400 on invalid).
 * Revenue & profit count ONLY invoiced/delivered tickets (isInvoiceSettled), never Cancelled, Unrepairable or shop-owned.
 * Active stages: Received, Diagnosing, Waiting approval, Waiting parts, In repair, Quality check.
 */
export async function getRepairsReport({
  tenantId,
  branchId,
  startDate,
  endDate,
  query = {},
  viewCostMargin = false,
}) {
  validateBranchId(branchId);
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { start, end } = parseColomboDateRange(startDate, endDate);
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    isArchived: false,
    createdAt: { $gte: start, $lte: end },
  };
  if (bId) matchFilter.branchId = bId;

  if (query.stage !== undefined) {
    if (typeof query.stage !== 'string' || !REPAIR_STAGES.includes(query.stage)) {
      throw badRequest('Invalid repair stage', 'INVALID_STAGE');
    }
    matchFilter.stage = query.stage;
  }

  if (query.technicianId !== undefined) {
    if (typeof query.technicianId !== 'string' || !mongoose.isValidObjectId(query.technicianId)) {
      throw badRequest('Invalid technicianId', 'INVALID_TECHNICIAN_ID');
    }
    matchFilter.technicianId = new mongoose.Types.ObjectId(query.technicianId);
  }

  const repairsPipeline = [
    { $match: matchFilter },
    {
      $addFields: {
        ticketPartsSellingCents: {
          $sum: {
            $map: {
              input: { $ifNull: ['$parts', []] },
              as: 'p',
              in: { $multiply: [{ $ifNull: ['$$p.unitPriceCents', 0] }, { $ifNull: ['$$p.qty', 1] }] },
            },
          },
        },
      },
    },
    {
      $addFields: {
        ticketTotalCents: {
          $cond: [
            { $gt: ['$invoiceTotalCents', 0] },
            '$invoiceTotalCents',
            { $add: [{ $ifNull: ['$labourCents', 0] }, '$ticketPartsSellingCents'] },
          ],
        },
      },
    },
  ];

  // Revenue & profit condition: isInvoiceSettled === true, not shopOwnedUnit, customerId != null, stage not Cancelled/Unrepairable
  const isSettledRevenueTicket = {
    $and: [
      { $eq: ['$isInvoiceSettled', true] },
      { $ne: ['$shopOwnedUnit', true] },
      { $ne: ['$customerId', null] },
      { $not: [{ $in: ['$stage', ['Cancelled', 'Unrepairable']] }] },
    ],
  };

  const summaryAgg = await RepairTicket.aggregate([
    ...repairsPipeline,
    {
      $group: {
        _id: null,
        totalTickets: { $sum: 1 },
        totalLabourCents: {
          $sum: { $cond: [isSettledRevenueTicket, { $ifNull: ['$labourCents', 0] }, 0] },
        },
        totalPartsSellingCents: {
          $sum: { $cond: [isSettledRevenueTicket, '$ticketPartsSellingCents', 0] },
        },
        totalPartsCostCents: {
          $sum: { $cond: [isSettledRevenueTicket, { $ifNull: ['$partsCostCents', 0] }, 0] },
        },
        totalGrandTotalCents: {
          $sum: { $cond: [isSettledRevenueTicket, '$ticketTotalCents', 0] },
        },
        deliveredCount: {
          $sum: { $cond: [{ $eq: ['$stage', 'Delivered'] }, 1, 0] },
        },
        cancelledCount: {
          $sum: { $cond: [{ $in: ['$stage', ['Cancelled', 'Unrepairable']] }, 1, 0] },
        },
        activeCount: {
          $sum: {
            $cond: [{ $in: ['$stage', ACTIVE_REPAIR_STAGES] }, 1, 0],
          },
        },
      },
    },
  ]);

  const summary = summaryAgg[0] || {
    totalTickets: 0,
    totalLabourCents: 0,
    totalPartsSellingCents: 0,
    totalPartsCostCents: 0,
    totalGrandTotalCents: 0,
    deliveredCount: 0,
    cancelledCount: 0,
    activeCount: 0,
  };

  const totalCount = summary.totalTickets;
  const totalPages = Math.ceil(totalCount / limit) || 1;

  const rawTickets = await RepairTicket.aggregate([
    ...repairsPipeline,
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
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
        publicCode: 1,
        createdAt: 1,
        stage: 1,
        device: 1,
        faultDescription: 1,
        labourCents: { $ifNull: ['$labourCents', 0] },
        partsSellingCents: '$ticketPartsSellingCents',
        partsCostCents: { $ifNull: ['$partsCostCents', 0] },
        grandTotalCents: '$ticketTotalCents',
        advanceCents: { $ifNull: ['$advanceCents', 0] },
        paymentStatus: 1,
        isInvoiceSettled: 1,
        shopOwnedUnit: 1,
        customerId: 1,
        technicianId: 1,
        customerName: { $ifNull: [{ $arrayElemAt: ['$customerDoc.name', 0] }, 'Shop-Owned Unit'] },
        technicianName: { $ifNull: [{ $arrayElemAt: ['$techDoc.name', 0] }, 'Unassigned'] },
      },
    },
  ]);

  const items = rawTickets.map((t) => ({
    _id: t._id,
    ticketNo: t.ticketNo,
    publicCode: t.publicCode || '',
    createdAt: t.createdAt,
    stage: t.stage,
    device: `${t.device?.brand || ''} ${t.device?.model || ''}`.trim(),
    customerName: t.customerName,
    technicianId: t.technicianId,
    technicianName: t.technicianName,
    labourCents: t.labourCents,
    partsSellingCents: t.partsSellingCents,
    partsCostCents: viewCostMargin ? t.partsCostCents : null,
    grandTotalCents: t.grandTotalCents,
    advanceCents: t.advanceCents,
    paymentStatus: t.paymentStatus || (t.isInvoiceSettled ? 'paid' : 'unpaid'),
  }));

  return {
    summary: {
      period: { start, end },
      totalTickets: summary.totalTickets,
      activeCount: summary.activeCount,
      deliveredCount: summary.deliveredCount,
      cancelledCount: summary.cancelledCount,
      totalRevenueCents: summary.totalGrandTotalCents,
      totalLabourCents: summary.totalLabourCents,
      totalPartsSellingCents: summary.totalPartsSellingCents,
      totalPartsCostCents: viewCostMargin ? summary.totalPartsCostCents : null,
      netRepairsProfitCents: viewCostMargin
        ? summary.totalGrandTotalCents - summary.totalPartsCostCents
        : null,
    },
    pagination: { page, limit, totalCount, totalPages },
    data: items,
  };
}

/**
 * 4. Receivables Report
 * Only completed, partially_returned invoices (same rule as dashboard).
 */
export async function getReceivablesReport({
  tenantId,
  branchId,
  query = {},
}) {
  validateBranchId(branchId);
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    status: { $in: ['completed', 'partially_returned'] },
    paymentStatus: { $in: ['unpaid', 'partially_paid', 'overdue'] },
  };
  if (bId) matchFilter.branchId = bId;

  // Receivables summary
  const summaryAgg = await Invoice.aggregate([
    { $match: matchFilter },
    {
      $project: {
        grandTotalCents: 1,
        totalPaidCents: 1,
        balanceDueCents: { $subtract: ['$grandTotalCents', '$totalPaidCents'] },
        ageDays: {
          $divide: [{ $subtract: [new Date(), '$createdAt'] }, 1000 * 60 * 60 * 24],
        },
      },
    },
    { $match: { balanceDueCents: { $gt: 0 } } },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        totalReceivablesCents: { $sum: '$balanceDueCents' },
        current0to30Cents: {
          $sum: { $cond: [{ $lte: ['$ageDays', 30] }, '$balanceDueCents', 0] },
        },
        overdue31to60Cents: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ['$ageDays', 30] }, { $lte: ['$ageDays', 60] }] },
              '$balanceDueCents',
              0,
            ],
          },
        },
        overdue61to90Cents: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ['$ageDays', 60] }, { $lte: ['$ageDays', 90] }] },
              '$balanceDueCents',
              0,
            ],
          },
        },
        overdue90PlusCents: {
          $sum: { $cond: [{ $gt: ['$ageDays', 90] }, '$balanceDueCents', 0] },
        },
      },
    },
  ]);

  const summary = summaryAgg[0] || {
    totalInvoices: 0,
    totalReceivablesCents: 0,
    current0to30Cents: 0,
    overdue31to60Cents: 0,
    overdue61to90Cents: 0,
    overdue90PlusCents: 0,
  };

  const totalCount = summary.totalInvoices;
  const totalPages = Math.ceil(totalCount / limit) || 1;

  const rawInvoices = await Invoice.aggregate([
    { $match: matchFilter },
    {
      $addFields: {
        balanceDueCents: { $subtract: ['$grandTotalCents', '$totalPaidCents'] },
        daysOutstanding: {
          $floor: {
            $divide: [{ $subtract: [new Date(), '$createdAt'] }, 1000 * 60 * 60 * 24],
          },
        },
      },
    },
    { $match: { balanceDueCents: { $gt: 0 } } },
    { $sort: { createdAt: 1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customerDoc',
      },
    },
    {
      $project: {
        invoiceNumber: 1,
        createdAt: 1,
        grandTotalCents: 1,
        totalPaidCents: 1,
        balanceDueCents: 1,
        daysOutstanding: 1,
        paymentStatus: 1,
        customerName: {
          $ifNull: [
            '$customerSnapshot.name',
            { $ifNull: [{ $arrayElemAt: ['$customerDoc.name', 0] }, 'Walk-in Customer'] },
          ],
        },
        customerPhone: {
          $ifNull: [
            '$customerSnapshot.phone',
            { $ifNull: [{ $arrayElemAt: ['$customerDoc.phone', 0] }, ''] },
          ],
        },
      },
    },
  ]);

  return {
    summary: {
      totalInvoices: summary.totalInvoices,
      totalReceivablesCents: summary.totalReceivablesCents,
      aging: {
        current0to30Cents: summary.current0to30Cents,
        overdue31to60Cents: summary.overdue31to60Cents,
        overdue61to90Cents: summary.overdue61to90Cents,
        overdue90PlusCents: summary.overdue90PlusCents,
      },
    },
    pagination: { page, limit, totalCount, totalPages },
    data: rawInvoices,
  };
}

/**
 * 5. Export Report CSV
 * Loops pages up to 5000 rows. If more exist, sets isTruncated = true.
 * Amounts have numeric: true so negative values (e.g. -12.50) are not prefixed with an apostrophe.
 */
export async function exportReportCsv({
  type,
  tenantId,
  branchId,
  startDate,
  endDate,
  query = {},
  viewCostMargin = false,
}) {
  const MAX_EXPORT = 5000;
  const PAGE_SIZE = 200;
  let allRows = [];
  let page = 1;
  let totalCount = 0;

  const fetchPage = async (p, l) => {
    const q = { ...query, page: p, limit: l };
    if (type === 'sales') return getSalesReport({ tenantId, branchId, startDate, endDate, query: q, viewCostMargin });
    if (type === 'inventory') return getInventoryReport({ tenantId, branchId, query: q, viewCostMargin });
    if (type === 'repairs') return getRepairsReport({ tenantId, branchId, startDate, endDate, query: q, viewCostMargin });
    if (type === 'receivables') return getReceivablesReport({ tenantId, branchId, query: q });
    throw badRequest(`Unknown report type: ${type}`, 'INVALID_REPORT_TYPE');
  };

  while (allRows.length < MAX_EXPORT) {
    const fetchLimit = Math.min(PAGE_SIZE, MAX_EXPORT - allRows.length);
    const result = await fetchPage(page, fetchLimit);
    totalCount = result.pagination.totalCount;
    if (!result.data || result.data.length === 0) break;
    allRows.push(...result.data);
    if (allRows.length >= totalCount || result.data.length < fetchLimit) break;
    page++;
  }

  const isTruncated = totalCount > MAX_EXPORT;

  if (type === 'sales') {
    const columns = [
      { key: 'invoiceNumber', label: 'Invoice No' },
      {
        key: 'createdAt',
        label: 'Date',
        format: (val) => (val ? new Date(val).toISOString().slice(0, 10) : ''),
      },
      { key: 'customerName', label: 'Customer' },
      { key: 'branchName', label: 'Branch' },
      {
        key: 'grandTotalCents',
        label: 'Total (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'totalPaidCents',
        label: 'Paid (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'balanceDueCents',
        label: 'Balance (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      { key: 'paymentStatus', label: 'Payment Status' },
      { key: 'status', label: 'Status' },
    ];

    if (viewCostMargin) {
      columns.push(
        {
          key: 'costCents',
          label: 'Cost (Rs)',
          numeric: true,
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        },
        {
          key: 'profitCents',
          label: 'Profit (Rs)',
          numeric: true,
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        }
      );
    }

    return {
      csv: buildCsv(columns, allRows),
      filename: `sales_report_${new Date().toISOString().slice(0, 10)}.csv`,
      isTruncated,
      totalCount,
    };
  }

  if (type === 'inventory') {
    const columns = [
      { key: 'name', label: 'Product Name' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'sku', label: 'SKU' },
      { key: 'qtyOnHand', label: 'Qty on Hand', numeric: true },
      {
        key: 'sellingPriceCents',
        label: 'Retail Price (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'totalRetailValueCents',
        label: 'Total Retail Value (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
    ];

    if (viewCostMargin) {
      columns.push(
        {
          key: 'averageCostCents',
          label: 'Average Cost (Rs)',
          numeric: true,
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        },
        {
          key: 'totalCostValueCents',
          label: 'Total Cost Value (Rs)',
          numeric: true,
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        }
      );
    }

    return {
      csv: buildCsv(columns, allRows),
      filename: `inventory_report_${new Date().toISOString().slice(0, 10)}.csv`,
      isTruncated,
      totalCount,
    };
  }

  if (type === 'repairs') {
    const columns = [
      { key: 'ticketNo', label: 'Ticket No' },
      { key: 'publicCode', label: 'Tracking Code' },
      {
        key: 'createdAt',
        label: 'Intake Date',
        format: (val) => (val ? new Date(val).toISOString().slice(0, 10) : ''),
      },
      { key: 'device', label: 'Device' },
      { key: 'customerName', label: 'Customer' },
      { key: 'technicianName', label: 'Technician' },
      { key: 'stage', label: 'Stage' },
      {
        key: 'labourCents',
        label: 'Labour (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'partsSellingCents',
        label: 'Parts (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'grandTotalCents',
        label: 'Total (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'advanceCents',
        label: 'Advance (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      { key: 'paymentStatus', label: 'Payment Status' },
    ];

    if (viewCostMargin) {
      columns.push({
        key: 'partsCostCents',
        label: 'Parts Cost (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      });
    }

    return {
      csv: buildCsv(columns, allRows),
      filename: `repairs_report_${new Date().toISOString().slice(0, 10)}.csv`,
      isTruncated,
      totalCount,
    };
  }

  if (type === 'receivables') {
    const columns = [
      { key: 'invoiceNumber', label: 'Invoice No' },
      {
        key: 'createdAt',
        label: 'Date',
        format: (val) => (val ? new Date(val).toISOString().slice(0, 10) : ''),
      },
      { key: 'customerName', label: 'Customer' },
      { key: 'customerPhone', label: 'Phone' },
      {
        key: 'grandTotalCents',
        label: 'Total (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'totalPaidCents',
        label: 'Paid (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      {
        key: 'balanceDueCents',
        label: 'Outstanding (Rs)',
        numeric: true,
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      },
      { key: 'daysOutstanding', label: 'Days Outstanding', numeric: true },
      { key: 'paymentStatus', label: 'Status' },
    ];

    return {
      csv: buildCsv(columns, allRows),
      filename: `receivables_report_${new Date().toISOString().slice(0, 10)}.csv`,
      isTruncated,
      totalCount,
    };
  }

  throw badRequest(`Unknown report type: ${type}`, 'INVALID_REPORT_TYPE');
}
