import mongoose from 'mongoose';
import RepairTicket from './models/RepairTicket.model.js';
import repairsService, { ALLOWED_STAGES } from './services/repairs.service.js';
import { decryptPasscode, hasPasscodeKey } from './utils/passcode.js';
import { resolveBranch, resolveRecordBranch } from '../pos/utils/branch.js';
import { hasPermission, hasSpecial } from '../../core/permissions.js';
import { badRequest, notFound, forbidden } from '../../core/errors.js';
import { pick, escapeRegex, pageParams, requireId } from '../../core/validate.js';
import { maskPhone, maskNic } from '../customers/utils/mask.js';
import { buildWhatsAppLink } from '../notifications/utils/whatsapp.js';
import audit from '../../core/audit.js';

/**
 * Checks if current user is restricted technician (has repairs.view but not repairs.create, and not owner).
 */
const userOf = (req) => ({ _id: req.auth.userId, role: req.auth.role });

function isRestrictedTechnician(role) {
  if (!role || role.key === 'owner') return false;
  return hasPermission(role, 'repairs.view') && !hasPermission(role, 'repairs.create');
}

/**
 * Masks cost margin / parts cost if user lacks view_cost_margin special permission.
 */
function formatTicketResponse(ticket, role, { revealPasscode = false } = {}) {
  const doc = ticket.toObject ? ticket.toObject() : { ...ticket };

  // 1. Passcode handling
  if (!revealPasscode || !doc.passcodeEncrypted) {
    delete doc.passcodeEncrypted;
    doc.passcode = null;
  } else {
    doc.passcode = decryptPasscode(doc.passcodeEncrypted);
    delete doc.passcodeEncrypted;
  }

  // 2. Cost margin masking
  const canViewMargins = hasSpecial(role, 'view_cost_margin');
  if (!canViewMargins) {
    delete doc.partsCostCents;
    if (Array.isArray(doc.parts)) {
      doc.parts = doc.parts.map((p) => {
        const { unitCostCents, ...rest } = p;
        return rest;
      });
    }
  }

  return doc;
}

export async function config(req, res) {
  res.json({ data: { passcodeEnabled: hasPasscodeKey() } });
}

export async function create(req, res) {
  const branch = await resolveBranch(req);
  const body = req.body || {};

  const result = await repairsService.createTicket({
    tenantId: req.auth.tenantId,
    branchId: branch._id,
    customerId: body.customerId || null,
    customerData: body.customer || null,
    device: {
      brand: String(body.device?.brand || '').trim(),
      model: String(body.device?.model || '').trim(),
      imei: body.device?.imei ? String(body.device.imei).trim() : null,
      serial: body.device?.serial ? String(body.device.serial).trim() : null,
      colour: body.device?.colour ? String(body.device.colour).trim() : null,
    },
    accessories: Array.isArray(body.accessories) ? body.accessories.map((a) => String(a).trim()) : [],
    conditionNotes: body.conditionNotes ? String(body.conditionNotes).trim() : '',
    photoUrls: Array.isArray(body.photoUrls) ? body.photoUrls.map((u) => String(u).trim()).slice(0, 6) : [],
    faultDescription: String(body.faultDescription || '').trim(),
    estimateCents: Number(body.estimateCents) || 0,
    advanceCents: Number(body.advanceCents) || 0,
    advancePaymentMethod: body.advancePaymentMethod || 'cash',
    promisedDate: body.promisedDate || null,
    technicianId: body.technicianId || null,
    passcode: body.passcode ? String(body.passcode).trim() : null,
    internalNotes: body.internalNotes ? String(body.internalNotes).trim() : '',
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.created',
    entity: 'RepairTicket',
    entityId: result.ticket._id,
    after: { ticketNo: result.ticket.ticketNo, customerId: result.customer._id, stage: result.ticket.stage },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.status(201).json({
    data: formatTicketResponse(result.ticket, req.auth.role),
    warning: result.warning,
  });
}

export async function list(req, res) {
  const { page, limit, skip } = pageParams(req.query);
  const q = String(req.query.q || '').trim();
  if (q.length > 100) throw badRequest('Search query too long (max 100 chars)');

  const filter = { isArchived: false };

  // Branch filtering
  if (req.query.branchId) {
    const branch = await resolveBranch(req, { branchId: req.query.branchId });
    filter.branchId = branch._id;
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    filter.branchId = { $in: req.auth.branchIds };
  }

  // Technician scoping: if restricted technician, only assigned tickets
  if (isRestrictedTechnician(req.auth.role)) {
    filter.technicianId = req.auth.userId;
  } else if (req.query.technicianId) {
    filter.technicianId = requireId(req.query.technicianId, 'technicianId');
  }

  // Stage filter
  if (req.query.stage) {
    if (!ALLOWED_STAGES.includes(req.query.stage)) {
      throw badRequest(`Invalid stage filter: ${req.query.stage}`);
    }
    filter.stage = req.query.stage;
  }

  // Customer filter
  if (req.query.customerId) {
    filter.customerId = requireId(req.query.customerId, 'customerId');
  }

  // Overdue filter
  if (req.query.overdue === 'true') {
    filter.promisedDate = { $lt: new Date() };
    filter.stage = { $nin: ['Ready', 'Delivered', 'Cancelled', 'Unrepairable'] };
  }

  // Search query
  if (q) {
    const escaped = escapeRegex(q);
    const reg = new RegExp(escaped, 'i');
    filter.$or = [
      { ticketNo: reg },
      { 'device.brand': reg },
      { 'device.model': reg },
      { 'device.imei': reg },
      { 'device.serial': reg },
    ];
  }

  const [total, docs] = await Promise.all([
    RepairTicket.countDocuments(filter),
    RepairTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'name phone nic')
      .populate('technicianId', 'name email')
      .lean(),
  ]);

  // Mask customer sensitive data & omit passcode/internalNotes
  const maskedDocs = docs.map((d) => {
    delete d.passcodeEncrypted;
    delete d.internalNotes;
    if (d.customerId) {
      d.customerId.phone = maskPhone(d.customerId.phone);
      d.customerId.nic = maskNic(d.customerId.nic);
    }
    return formatTicketResponse(d, req.auth.role);
  });

  res.json({
    data: maskedDocs,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 1,
  });
}

export async function board(req, res) {
  const branchFilter = {};
  if (req.query.branchId) {
    const branch = await resolveBranch(req, { branchId: req.query.branchId });
    branchFilter.branchId = branch._id;
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    branchFilter.branchId = { $in: req.auth.branchIds };
  }

  const filter = { isArchived: false, ...branchFilter };
  if (isRestrictedTechnician(req.auth.role)) {
    filter.technicianId = req.auth.userId;
  }

  const tickets = await RepairTicket.find(filter)
    .sort({ createdAt: -1 })
    .populate('customerId', 'name phone')
    .populate('technicianId', 'name')
    .lean();

  const boardMap = {};
  for (const stage of ALLOWED_STAGES) {
    boardMap[stage] = { count: 0, items: [] };
  }

  for (const t of tickets) {
    delete t.passcodeEncrypted;
    delete t.internalNotes;
    if (t.customerId) {
      t.customerId.phone = maskPhone(t.customerId.phone);
    }
    const stageKey = t.stage || 'Received';
    if (!boardMap[stageKey]) boardMap[stageKey] = { count: 0, items: [] };
    boardMap[stageKey].count += 1;
    boardMap[stageKey].items.push(formatTicketResponse(t, req.auth.role));
  }

  res.json({ data: boardMap });
}

export async function overdue(req, res) {
  const branchFilter = {};
  if (req.query.branchId) {
    const branch = await resolveBranch(req, { branchId: req.query.branchId });
    branchFilter.branchId = branch._id;
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    branchFilter.branchId = { $in: req.auth.branchIds };
  }

  const filter = {
    isArchived: false,
    promisedDate: { $lt: new Date() },
    stage: { $nin: ['Ready', 'Delivered', 'Cancelled', 'Unrepairable'] },
    ...branchFilter,
  };

  if (isRestrictedTechnician(req.auth.role)) {
    filter.technicianId = req.auth.userId;
  }

  const docs = await RepairTicket.find(filter)
    .sort({ promisedDate: 1 })
    .populate('customerId', 'name phone')
    .populate('technicianId', 'name')
    .lean();

  const data = docs.map((d) => {
    delete d.passcodeEncrypted;
    if (d.customerId) d.customerId.phone = maskPhone(d.customerId.phone);
    return formatTicketResponse(d, req.auth.role);
  });

  res.json({ data, count: data.length });
}

export async function techniciansWorkload(req, res) {
  let branchId = null;
  if (req.query.branchId) {
    const branch = await resolveBranch(req, { branchId: req.query.branchId });
    branchId = branch._id;
  } else if (!hasSpecial(req.auth.role, 'view_all_branches')) {
    branchId = req.auth.branchIds?.[0];
  }

  const data = await repairsService.getTechniciansWorkload({
    tenantId: req.auth.tenantId,
    branchId,
  });

  res.json({ data });
}

export async function getOne(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const ticket = await RepairTicket.findById(id)
    .populate('customerId', 'name phone email nic address')
    .populate('technicianId', 'name email')
    .populate('createdBy', 'name email');

  if (!ticket) throw notFound('Repair ticket not found');

  // Restricted technician cannot view other technician's ticket
  if (isRestrictedTechnician(req.auth.role)) {
    if (String(ticket.technicianId?._id || ticket.technicianId) !== String(req.auth.userId)) {
      throw notFound('Repair ticket not found');
    }
  }

  const reveal = req.query.revealPasscode === 'true';
  const canReveal = req.auth.role?.key === 'owner' || String(ticket.technicianId?._id || ticket.technicianId) === String(req.auth.userId);

  if (reveal && canReveal) {
    await audit.record({
      action: 'repair.passcode_revealed',
      entity: 'RepairTicket',
      entityId: ticket._id,
      after: { ticketNo: ticket.ticketNo },
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });
  }

  res.json({
    data: formatTicketResponse(ticket, req.auth.role, { revealPasscode: reveal && canReveal }),
  });
}

export async function update(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const ticket = await RepairTicket.findById(id);
  if (!ticket) throw notFound('Repair ticket not found');

  const allowed = pick(req.body, ['conditionNotes', 'faultDescription', 'estimateCents', 'promisedDate', 'accessories', 'internalNotes']);

  const before = {
    conditionNotes: ticket.conditionNotes,
    faultDescription: ticket.faultDescription,
    estimateCents: ticket.estimateCents,
    promisedDate: ticket.promisedDate,
    accessories: ticket.accessories,
    internalNotes: ticket.internalNotes,
  };

  if (allowed.conditionNotes !== undefined) ticket.conditionNotes = String(allowed.conditionNotes).trim();
  if (allowed.faultDescription !== undefined) ticket.faultDescription = String(allowed.faultDescription).trim();
  if (allowed.estimateCents !== undefined) ticket.estimateCents = Math.max(0, Math.round(Number(allowed.estimateCents) || 0));
  if (allowed.promisedDate !== undefined) ticket.promisedDate = allowed.promisedDate ? new Date(allowed.promisedDate) : null;
  if (Array.isArray(allowed.accessories)) ticket.accessories = allowed.accessories.map((a) => String(a).trim());
  if (allowed.internalNotes !== undefined) ticket.internalNotes = String(allowed.internalNotes).trim();

  await ticket.save();

  await audit.record({
    action: 'repair.updated',
    entity: 'RepairTicket',
    entityId: ticket._id,
    before,
    after: allowed,
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function stage(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const { to, note, advanceDecision, feeCents, paymentMethod, waiveApproval } = req.body || {};
  if (!to) throw badRequest('Next stage "to" is required');

  const { ticket, isReopen } = await repairsService.changeStage({
    tenantId: req.auth.tenantId,
    ticketId: id,
    to,
    note,
    advanceDecision,
    feeCents: Number(feeCents) || 0,
    paymentMethod: paymentMethod || null,
    waiveApproval: Boolean(waiveApproval),
    user: userOf(req),
  });

  await audit.record({
    action: isReopen ? 'repair.reopened' : 'repair.stage_changed',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, stage: ticket.stage, note },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function assign(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const { technicianId } = req.body || {};
  const ticket = await repairsService.assignTechnician({
    tenantId: req.auth.tenantId,
    ticketId: id,
    technicianId: technicianId ? requireId(technicianId, 'technicianId') : null,
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.assigned',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, technicianId },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function approval(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const { decision, by } = req.body || {};
  const ticket = await repairsService.recordApproval({
    tenantId: req.auth.tenantId,
    ticketId: id,
    decision,
    by,
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.approval_recorded',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, decision, by },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function addPart(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const ticket = await repairsService.addPart({
    tenantId: req.auth.tenantId,
    ticketId: id,
    partData: req.body || {},
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.part_added',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, part: req.body?.name },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.status(201).json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function removePart(req, res) {
  const { id, partId } = req.params;
  requireId(id, 'ticket id');
  requireId(partId, 'part id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const ticket = await repairsService.removePart({
    tenantId: req.auth.tenantId,
    ticketId: id,
    partId,
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.part_removed',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, partId },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function invoice(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const { paymentMethod, labourCents } = req.body || {};
  const ticket = await repairsService.settleInvoice({
    tenantId: req.auth.tenantId,
    ticketId: id,
    paymentMethod: paymentMethod || 'cash',
    labourCents: labourCents !== undefined ? Number(labourCents) : null,
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.invoiced',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, invoiceTotalCents: ticket.invoiceTotalCents, paymentMethod },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function warranty(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const { days } = req.body || {};
  const ticket = await repairsService.setWarranty({
    tenantId: req.auth.tenantId,
    ticketId: id,
    days,
    user: userOf(req),
  });

  await audit.record({
    action: 'repair.warranty_updated',
    entity: 'RepairTicket',
    entityId: ticket._id,
    after: { ticketNo: ticket.ticketNo, warrantyDays: ticket.warrantyDays, warrantyExpiresAt: ticket.warrantyExpiresAt },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: formatTicketResponse(ticket, req.auth.role) });
}

export async function jobCard(req, res) {
  const { id } = req.params;
  requireId(id, 'ticket id');

  await resolveRecordBranch(req, RepairTicket, id, 'Repair ticket');

  const ticket = await RepairTicket.findById(id)
    .populate('customerId', 'name phone email nic address')
    .populate('technicianId', 'name')
    .populate('branchId', 'name phone address');

  if (!ticket) throw notFound('Repair ticket not found');

  const partsTotal = ticket.parts.reduce((sum, p) => sum + (p.qty || 1) * (p.unitPriceCents || 0), 0);
  const estimatedTotal = ticket.estimateCents || (ticket.labourCents + partsTotal);
  const remainingDue = Math.max(0, estimatedTotal - (ticket.advanceCents || 0));

  // WhatsApp message for customer
  const waText = `Hi ${ticket.customerId?.name || 'Customer'}, your repair job #${ticket.ticketNo} for ${ticket.device.brand} ${ticket.device.model} is registered with Cellivo. Status: ${ticket.stage}.`;
  const whatsappLink = ticket.customerId?.phone ? buildWhatsAppLink(ticket.customerId.phone, waText) : '';

  res.json({
    data: {
      ticketNo: ticket.ticketNo,
      createdAt: ticket.createdAt,
      promisedDate: ticket.promisedDate,
      stage: ticket.stage,
      customer: {
        name: ticket.customerId?.name,
        phone: ticket.customerId?.phone,
        email: ticket.customerId?.email,
      },
      device: ticket.device,
      faultDescription: ticket.faultDescription,
      accessories: ticket.accessories,
      conditionNotes: ticket.conditionNotes,
      financials: {
        estimateCents: ticket.estimateCents,
        advanceCents: ticket.advanceCents,
        remainingDueCents: remainingDue,
        isSettled: ticket.isInvoiceSettled,
      },
      technician: ticket.technicianId ? { name: ticket.technicianId.name } : null,
      branch: ticket.branchId ? { name: ticket.branchId.name, phone: ticket.branchId.phone } : null,
      qrPayloadPlaceholder: `http://localhost:3000/status/${ticket.ticketNo}`, // TODO Phase 4: Public status URL
      whatsappLink,
    },
  });
}

export default {
  create,
  list,
  board,
  overdue,
  techniciansWorkload,
  getOne,
  update,
  stage,
  assign,
  approval,
  addPart,
  removePart,
  invoice,
  warranty,
  jobCard,
};
