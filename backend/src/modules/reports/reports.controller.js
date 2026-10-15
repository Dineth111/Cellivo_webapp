import { hasSpecial } from '../../core/permissions.js';
import { forbidden } from '../../core/errors.js';
import * as reportsService from './services/reports.service.js';

function resolveBranchId(req) {
  const canViewAll = hasSpecial(req.auth.role, 'view_all_branches');
  if (canViewAll) {
    return req.query.branchId || null;
  }
  const userBranchIds = (req.auth.branchIds || []).map((b) => String(b));
  if (userBranchIds.length === 0) {
    throw forbidden('No branch assigned to user');
  }
  if (req.query.branchId) {
    const requested = String(req.query.branchId);
    if (!userBranchIds.includes(requested)) {
      throw forbidden('Access to requested branch is forbidden');
    }
    return requested;
  }
  return userBranchIds[0];
}

export async function getSalesReport(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const branchId = resolveBranchId(req);
    const viewCostMargin = hasSpecial(req.auth.role, 'view_cost_margin');
    const { startDate, endDate } = req.query;

    const result = await reportsService.getSalesReport({
      tenantId,
      branchId,
      startDate,
      endDate,
      query: req.query,
      viewCostMargin,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getInventoryReport(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const branchId = resolveBranchId(req);
    const viewCostMargin = hasSpecial(req.auth.role, 'view_cost_margin');

    const result = await reportsService.getInventoryReport({
      tenantId,
      branchId,
      query: req.query,
      viewCostMargin,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getRepairsReport(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const branchId = resolveBranchId(req);
    const viewCostMargin = hasSpecial(req.auth.role, 'view_cost_margin');
    const { startDate, endDate } = req.query;

    const result = await reportsService.getRepairsReport({
      tenantId,
      branchId,
      startDate,
      endDate,
      query: req.query,
      viewCostMargin,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getReceivablesReport(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const branchId = resolveBranchId(req);

    const result = await reportsService.getReceivablesReport({
      tenantId,
      branchId,
      query: req.query,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function exportReportCsv(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const branchId = resolveBranchId(req);
    const viewCostMargin = hasSpecial(req.auth.role, 'view_cost_margin');
    const { type } = req.params;
    const { startDate, endDate } = req.query;

    const { csv, filename } = await reportsService.exportReportCsv({
      type,
      tenantId,
      branchId,
      startDate,
      endDate,
      query: req.query,
      viewCostMargin,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}
