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

/**
 * 1. Sales Report
 */
export async function getSalesReport({
  tenantId,
  branchId,
  startDate,
  endDate,
  query = {},
  viewCostMargin = false,
}) {
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { start, end } = parseColomboDateRange(startDate, endDate);
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    status: { $ne: 'voided' },
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
 */
export async function getInventoryReport({
  tenantId,
  branchId,
  query = {},
  viewCostMargin = false,
}) {
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    isArchived: false,
  };

  // Aggregation pipeline starting with tenantId match on Product
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
        avgCostCents: {
          $cond: [
            { $gt: [{ $size: '$stockLevels' }, 0] },
            { $avg: '$stockLevels.averageCostCents' },
            { $ifNull: ['$costPriceCents', 0] },
          ],
        },
      },
    },
    {
      $addFields: {
        totalRetailValueCents: { $multiply: ['$totalQtyOnHand', '$sellingPriceCents'] },
        totalCostValueCents: { $multiply: ['$totalQtyOnHand', '$avgCostCents'] },
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
    isLowStock: (p.totalQtyOnHand || 0) <= (p.reorderLevel || 0),
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
 */
export async function getRepairsReport({
  tenantId,
  branchId,
  startDate,
  endDate,
  query = {},
  viewCostMargin = false,
}) {
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
  if (query.stage) matchFilter.stage = query.stage;
  if (query.technicianId) matchFilter.assignedTechnicianId = new mongoose.Types.ObjectId(query.technicianId);

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

  // Summary aggregation
  const summaryAgg = await RepairTicket.aggregate([
    ...repairsPipeline,
    {
      $group: {
        _id: null,
        totalTickets: { $sum: 1 },
        totalLabourCents: { $sum: { $ifNull: ['$labourCents', 0] } },
        totalPartsSellingCents: { $sum: '$ticketPartsSellingCents' },
        totalPartsCostCents: { $sum: { $ifNull: ['$partsCostCents', 0] } },
        totalGrandTotalCents: { $sum: '$ticketTotalCents' },
        deliveredCount: {
          $sum: { $cond: [{ $eq: ['$stage', 'Delivered'] }, 1, 0] },
        },
        cancelledCount: {
          $sum: { $cond: [{ $in: ['$stage', ['Cancelled', 'Unrepairable']] }, 1, 0] },
        },
        activeCount: {
          $sum: {
            $cond: [
              { $in: ['$stage', ['Received', 'Diagnostic', 'In repair', 'Quality check', 'Ready']] },
              1,
              0,
            ],
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
        localField: 'assignedTechnicianId',
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
 */
export async function getReceivablesReport({
  tenantId,
  branchId,
  query = {},
}) {
  const tId = new mongoose.Types.ObjectId(tenantId);
  const bId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const { page, limit, skip } = parsePagination(query);

  const matchFilter = {
    tenantId: tId,
    status: { $ne: 'voided' },
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
  // Export up to 5000 rows (unpaginated for CSV)
  const exportQuery = { ...query, page: 1, limit: 200 };

  if (type === 'sales') {
    const report = await getSalesReport({
      tenantId,
      branchId,
      startDate,
      endDate,
      query: exportQuery,
      viewCostMargin,
    });

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
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'totalPaidCents',
        label: 'Paid (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'balanceDueCents',
        label: 'Balance (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      { key: 'paymentStatus', label: 'Payment Status' },
      { key: 'status', label: 'Status' },
    ];

    if (viewCostMargin) {
      columns.push(
        {
          key: 'costCents',
          label: 'Cost (Rs)',
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        },
        {
          key: 'profitCents',
          label: 'Profit (Rs)',
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        }
      );
    }

    return {
      csv: buildCsv(columns, report.data),
      filename: `sales_report_${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  if (type === 'inventory') {
    const report = await getInventoryReport({
      tenantId,
      branchId,
      query: exportQuery,
      viewCostMargin,
    });

    const columns = [
      { key: 'name', label: 'Product Name' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'sku', label: 'SKU' },
      { key: 'qtyOnHand', label: 'Qty on Hand' },
      {
        key: 'sellingPriceCents',
        label: 'Retail Price (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'totalRetailValueCents',
        label: 'Total Retail Value (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
    ];

    if (viewCostMargin) {
      columns.push(
        {
          key: 'averageCostCents',
          label: 'Average Cost (Rs)',
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        },
        {
          key: 'totalCostValueCents',
          label: 'Total Cost Value (Rs)',
          format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
        }
      );
    }

    return {
      csv: buildCsv(columns, report.data),
      filename: `inventory_report_${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  if (type === 'repairs') {
    const report = await getRepairsReport({
      tenantId,
      branchId,
      startDate,
      endDate,
      query: exportQuery,
      viewCostMargin,
    });

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
      { key: 'stage', label: 'Stage' },
      {
        key: 'labourCents',
        label: 'Labour (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'partsSellingCents',
        label: 'Parts (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'grandTotalCents',
        label: 'Total (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'advanceCents',
        label: 'Advance (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      { key: 'paymentStatus', label: 'Payment Status' },
    ];

    if (viewCostMargin) {
      columns.push({
        key: 'partsCostCents',
        label: 'Parts Cost (Rs)',
        format: (val) => (val != null ? (val / 100).toFixed(2) : ''),
      });
    }

    return {
      csv: buildCsv(columns, report.data),
      filename: `repairs_report_${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  if (type === 'receivables') {
    const report = await getReceivablesReport({
      tenantId,
      branchId,
      query: exportQuery,
    });

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
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'totalPaidCents',
        label: 'Paid (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      {
        key: 'balanceDueCents',
        label: 'Outstanding (Rs)',
        format: (val) => (val / 100).toFixed(2),
      },
      { key: 'daysOutstanding', label: 'Days Outstanding' },
      { key: 'paymentStatus', label: 'Status' },
    ];

    return {
      csv: buildCsv(columns, report.data),
      filename: `receivables_report_${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  throw badRequest(`Unknown report type: ${type}`, 'INVALID_REPORT_TYPE');
}
