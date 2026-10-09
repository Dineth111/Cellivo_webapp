import * as imeiService from '../services/imei.service.js';
import { str, requireId } from '../../../core/validate.js';
import { badRequest } from '../../../core/errors.js';
import { maskCost } from '../utils/maskCost.js';
import { resolveBranch } from '../../pos/utils/branch.js';

export async function searchImei(req, res) {
  const query = str(req.query.q || req.query.query || req.query.search);
  if (!query) return res.json({ success: true, data: [] });

  const branch = await resolveBranch(req, { allowAll: true });
  const results = await imeiService.searchImei(req.auth.tenantId, query, branch ? branch._id : null);
  res.json({ success: true, data: maskCost(results, req.auth.role) });
}

export async function getImeiTimeline(req, res) {
  const imei = str(req.params.imei);
  if (!imei) throw badRequest('IMEI is required');

  const timeline = await imeiService.getImeiTimeline(req.auth.tenantId, imei);
  res.json({ success: true, data: maskCost(timeline, req.auth.role) });
}

export async function reserveImei(req, res) {
  const imei = str(req.params.imei);
  const cartId = str(req.body.cartId);
  const minutes = Number(req.body.minutes) || 15;
  const branch = await resolveBranch(req);

  const result = await imeiService.reserveImei(
    req.auth.tenantId,
    branch._id,
    imei,
    cartId,
    minutes,
    req.auth.userId
  );
  res.json({ success: true, data: result });
}

export async function releaseImei(req, res) {
  const imei = str(req.params.imei);
  const branch = await resolveBranch(req);

  const result = await imeiService.releaseImei(req.auth.tenantId, branch._id, imei);
  res.json({ success: true, data: result });
}

export async function updateImeiStatus(req, res) {
  const imei = str(req.params.imei);
  const newStatus = str(req.body.status);
  const cartId = str(req.body.cartId);
  const reason = str(req.body.reason);
  if (!newStatus) throw badRequest('New status is required');
  if (!reason || !reason.trim()) throw badRequest('Reason is required', 'REASON_REQUIRED');

  const branch = await resolveBranch(req, { allowAll: true });
  const updated = await imeiService.transitionStatus({
    tenantId: req.auth.tenantId,
    imei,
    newStatus,
    cartId,
    branchId: branch ? branch._id : null,
    userId: req.auth.userId,
    reason,
  });

  res.json({ success: true, data: maskCost(updated, req.auth.role) });
}

export default {
  searchImei,
  getImeiTimeline,
  reserveImei,
  releaseImei,
  updateImeiStatus,
};
