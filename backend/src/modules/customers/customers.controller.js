import mongoose from 'mongoose';
import Customer from './Customer.model.js';
import LoyaltySettings from './LoyaltySettings.model.js';
import Invoice from '../pos/models/Invoice.model.js';
import CreditNote from '../pos/models/CreditNote.model.js';
import InstallmentPlan from '../pos/models/InstallmentPlan.model.js';
import LoyaltyTransaction from '../pos/models/LoyaltyTransaction.model.js';
import Payment from '../pos/models/Payment.model.js';
import Quotation from '../pos/models/Quotation.model.js';
import { reassignCustomerData } from './adapters/reassign.adapter.js';
import { DEFAULT_LOYALTY_SETTINGS } from '../pos/adapters/loyaltySettings.adapter.js';
import { maskCostMargins } from '../pos/services/sale.service.js';
import { hasSpecial } from '../../core/permissions.js';
import { getContext } from '../../core/tenantContext.js';
import { conflict, notFound, badRequest, AppError } from '../../core/errors.js';
import { str, pick, requireId, escapeRegex, pageParams } from '../../core/validate.js';
import { normalizePhone, phoneVariants } from './utils/phone.js';
import { maskPhone, maskNic } from './utils/mask.js';
import { parseCsvRows, validateCustomerCsvRows } from './utils/csv.js';
import audit from '../../core/audit.js';

const FIELDS = ['name', 'phone', 'email', 'address', 'nic', 'type', 'notes', 'tags', 'marketingOptIn'];

// Clean and whitelist string / array / boolean fields from req.body with length limits
const clean = (body) => {
  const p = pick(body, FIELDS);
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'tags' && Array.isArray(v)) {
      out.tags = v
        .map((t) => String(t).trim().slice(0, 50))
        .filter((t) => t.length > 0)
        .slice(0, 20);
    } else if (k === 'marketingOptIn') {
      out.marketingOptIn = v === true;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (k === 'name') out.name = trimmed.slice(0, 100);
      else if (k === 'email') out.email = trimmed.slice(0, 254);
      else if (k === 'address') out.address = trimmed.slice(0, 300);
      else if (k === 'nic') out.nic = trimmed.slice(0, 20);
      else if (k === 'notes') out.notes = trimmed.slice(0, 2000);
      else out[k] = trimmed;
    }
  }
  return out;
};

async function duplicatePhone(phone, exceptId) {
  const variants = phoneVariants(phone);
  // Check both active and archived records
  const existing = await Customer.findOne({
    phone: { $in: variants },
    ...(exceptId && { _id: { $ne: exceptId } }),
  });
  if (!existing) return;
  const message = existing.isArchived
    ? 'A customer with this phone number exists in archived records'
    : 'A customer with this phone number already exists';
  const err = new AppError(409, message, 'DUPLICATE_PHONE');
  err.data = existing;
  throw err;
}

/**
 * List customers (paginated, masked phone & nic, filtered, searched).
 */
export const getCustomers = async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { isArchived: req.query.archived === 'true' };

  const search = str(req.query.search)?.slice(0, 100);
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    const variants = phoneVariants(search);
    const orBranches = [
      { name: re },
      { phone: re },
      { email: re },
      { nic: re },
    ];
    if (variants.length > 0) {
      orBranches.push({ phone: { $in: variants } });
      for (const v of variants) {
        if (v !== search) {
          orBranches.push({ phone: { $regex: escapeRegex(v), $options: 'i' } });
        }
      }
    }
    filter.$or = orBranches;
  }

  const type = str(req.query.type);
  if (type && type !== 'all') filter.type = type;

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter),
  ]);

  // Mask sensitive phone & nic in list responses
  const maskedCustomers = customers.map((c) => ({
    ...c,
    phone: maskPhone(c.phone),
    nic: maskNic(c.nic),
  }));

  res.json({
    success: true,
    count: maskedCustomers.length,
    total,
    page,
    limit,
    data: maskedCustomers,
  });
};

/**
 * Get customer by ID (full, unmasked values).
 */
export const getCustomerById = async (req, res) => {
  requireId(req.params.id);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw notFound('Customer not found');
  res.json({ success: true, data: customer });
};

/**
 * Create customer (phone normalised on write).
 */
export const createCustomer = async (req, res) => {
  const data = clean(req.body);
  if (!data.name) throw badRequest('Customer name is required');
  if (!data.phone) throw badRequest('Phone number is required');

  const normalized = normalizePhone(data.phone);
  if (!normalized) {
    throw badRequest('Invalid phone number format. Must match E.164 (e.g. 0771234567, +94771234567)');
  }
  data.phone = normalized;
  await duplicatePhone(data.phone);

  const customer = await Customer.create(data);
  await audit.record({ action: 'customer.create', entity: 'Customer', entityId: customer._id, after: customer });
  res.status(201).json({ success: true, message: 'Customer created successfully', data: customer });
};

/**
 * Update customer (phone normalised on write).
 */
export const updateCustomer = async (req, res) => {
  requireId(req.params.id);
  const data = clean(req.body);

  if (data.phone !== undefined) {
    if (!data.phone) throw badRequest('Phone number is required');
    const normalized = normalizePhone(data.phone);
    if (!normalized) {
      throw badRequest('Invalid phone number format. Must match E.164 (e.g. 0771234567, +94771234567)');
    }
    data.phone = normalized;
    await duplicatePhone(data.phone, req.params.id);
  }

  const before = await Customer.findById(req.params.id);
  if (!before) throw notFound('Customer not found');

  const customer = await Customer.findOneAndUpdate({ _id: req.params.id }, data, { new: true, runValidators: true });
  await audit.record({ action: 'customer.update', entity: 'Customer', entityId: customer._id, before, after: customer });
  res.json({ success: true, message: 'Customer updated successfully', data: customer });
};

/**
 * Archive customer (never hard delete).
 */
export const deleteCustomer = async (req, res) => {
  requireId(req.params.id);
  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, isArchived: false },
    { isArchived: true },
    { new: true }
  );
  if (!customer) throw notFound('Customer not found');
  await audit.record({ action: 'customer.archive', entity: 'Customer', entityId: customer._id });
  res.json({ success: true, message: 'Customer archived successfully', id: req.params.id });
};

/**
 * Find likely duplicates across active customers using aggregation (max 200 groups).
 */
export const getDuplicates = async (req, res) => {
  const [phoneDups, nicDups, emailDups] = await Promise.all([
    Customer.aggregate([
      { $match: { isArchived: false, phone: { $exists: true, $ne: '' } } },
      { $group: { _id: '$phone', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 200 },
    ]),
    Customer.aggregate([
      { $match: { isArchived: false, nic: { $exists: true, $ne: '' } } },
      { $group: { _id: '$nic', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 200 },
    ]),
    Customer.aggregate([
      { $match: { isArchived: false, email: { $exists: true, $ne: '' } } },
      { $group: { _id: '$email', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 200 },
    ]),
  ]);

  const allIds = new Set();
  const rawGroups = [];

  for (const g of phoneDups) {
    g.ids.forEach((id) => allIds.add(id));
    rawGroups.push({ reason: 'duplicate_phone', matchedKey: g._id, count: g.count, ids: g.ids });
  }
  for (const g of nicDups) {
    g.ids.forEach((id) => allIds.add(id));
    rawGroups.push({ reason: 'duplicate_nic', matchedKey: g._id, count: g.count, ids: g.ids });
  }
  for (const g of emailDups) {
    g.ids.forEach((id) => allIds.add(id));
    rawGroups.push({ reason: 'duplicate_email', matchedKey: g._id, count: g.count, ids: g.ids });
  }

  const cappedGroups = rawGroups.slice(0, 200);
  const matchedDocs = await Customer.find({ _id: { $in: Array.from(allIds) } }).lean();
  const docMap = new Map(matchedDocs.map((d) => [String(d._id), d]));

  const duplicateGroups = cappedGroups.map((g) => ({
    reason: g.reason,
    matchedKey: g.matchedKey,
    count: g.count,
    customers: g.ids
      .map((id) => docMap.get(String(id)))
      .filter(Boolean)
      .map((c) => ({
        ...c,
        phone: maskPhone(c.phone),
        nic: maskNic(c.nic),
      })),
  }));

  res.json({
    success: true,
    count: duplicateGroups.length,
    data: duplicateGroups,
  });
};

/**
 * Merge two customers inside one atomic transaction.
 * All reads and writes run within the session.
 * Takes the source with findOneAndUpdate returning old doc, then $inc target with old balances and $max creditLimitCents.
 */
export const mergeCustomers = async (req, res) => {
  const sourceId = requireId(req.params.id, 'source customer id');
  const targetId = requireId(req.body?.intoId, 'intoId');

  if (String(sourceId) === String(targetId)) {
    throw badRequest('Cannot merge a customer into itself');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Read target inside session
    const target = await Customer.findOne(
      { _id: targetId, isArchived: false, mergedInto: null },
      null,
      { session }
    );

    if (!target) {
      const anyTarget = await Customer.findById(targetId, null, { session });
      if (!anyTarget) throw notFound('Target customer not found');
      throw badRequest('Target customer is archived or merged');
    }

    // Loop check: ensure target is not merged into source
    let curr = target;
    while (curr && curr.mergedInto) {
      if (curr.mergedInto.equals(sourceId)) {
        throw badRequest('Merge would create a circular reference');
      }
      curr = await Customer.findById(curr.mergedInto, null, { session });
    }

    // 2. Atomically claim source inside session and get old values
    const source = await Customer.findOneAndUpdate(
      { _id: sourceId, isArchived: false, mergedInto: null },
      {
        $set: {
          isArchived: true,
          mergedInto: target._id,
          currentBalanceCents: 0,
          loyaltyPoints: 0,
        },
      },
      { new: false, session }
    );

    if (!source) {
      const anySource = await Customer.findById(sourceId, null, { session });
      if (!anySource) throw notFound('Source customer not found');
      throw badRequest('Source customer is already archived or merged');
    }

    // Cross-tenant check
    if (!source.tenantId.equals(target.tenantId)) {
      throw notFound('Customer not found');
    }

    const tenantId = source.tenantId;

    // 3. Reassign references in Dev 3 collections via adapter inside session
    await reassignCustomerData(tenantId, source._id, target._id, session);

    // 4. Merge tags and notes
    const combinedTags = Array.from(new Set([...(target.tags || []), ...(source.tags || [])])).slice(0, 20);
    let mergedNotes = target.notes || '';
    if (source.notes) {
      if (!mergedNotes) {
        mergedNotes = source.notes;
      } else if (!mergedNotes.includes(source.notes)) {
        mergedNotes = `${mergedNotes}\n[Merged note]: ${source.notes}`.slice(0, 2000);
      }
    }

    // 5. Atomically $inc target balances and $max credit limit with session
    const updatedTarget = await Customer.findOneAndUpdate(
      { _id: target._id },
      {
        $inc: {
          currentBalanceCents: source.currentBalanceCents || 0,
          loyaltyPoints: source.loyaltyPoints || 0,
        },
        $max: {
          creditLimitCents: source.creditLimitCents || 0,
        },
        $set: {
          tags: combinedTags,
          notes: mergedNotes,
        },
      },
      { new: true, session }
    );

    await session.commitTransaction();

    await audit.record({
      action: 'customer.merge',
      entity: 'Customer',
      entityId: target._id,
      before: { sourceId: source._id, targetId: target._id },
      after: {
        mergedInto: target._id,
        currentBalanceCents: updatedTarget.currentBalanceCents,
        loyaltyPoints: updatedTarget.loyaltyPoints,
        creditLimitCents: updatedTarget.creditLimitCents,
      },
    });

    res.json({
      success: true,
      message: 'Customers merged successfully',
      data: updatedTarget,
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Customer history (invoices, payments, credit notes, installment plans, loyalty).
 * Passes invoices through maskCostMargins(invoice, hasSpecial(role, 'view_cost_margin')).
 *
 * TODO (Dev 5): Include repair tickets and devices owned once repairs and inventory modules exist.
 */
export const getCustomerHistory = async (req, res) => {
  const customerId = requireId(req.params.id);
  const customer = await Customer.findById(customerId);
  if (!customer) throw notFound('Customer not found');

  const { page, limit, skip } = pageParams(req.query, 50);

  // Read associated records across POS models
  const [invoices, creditNotes, installmentPlans, loyaltyTransactions] = await Promise.all([
    Invoice.find({ customerId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CreditNote.find({ customerId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    InstallmentPlan.find({ customerId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    LoyaltyTransaction.find({ customerId }).sort({ date: -1 }).skip(skip).limit(limit).lean(),
  ]);

  const invoiceIds = invoices.map((i) => i._id);
  const payments = invoiceIds.length
    ? await Payment.find({ invoiceId: { $in: invoiceIds } }).sort({ createdAt: -1 }).lean()
    : [];

  const role = req.auth?.role || getContext()?.role;
  const allowCostMargin = hasSpecial(role, 'view_cost_margin');
  const sanitizedInvoices = invoices.map((inv) => maskCostMargins(inv, allowCostMargin));

  res.json({
    success: true,
    data: {
      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        type: customer.type,
        currentBalanceCents: customer.currentBalanceCents,
        creditLimitCents: customer.creditLimitCents,
        loyaltyPoints: customer.loyaltyPoints,
      },
      invoices: sanitizedInvoices,
      payments,
      creditNotes,
      installmentPlans,
      loyaltyTransactions,
      devices: [],
      repairs: [],
    },
    page,
    limit,
  });
};

/**
 * CSV Import (all-or-nothing, per-row validation, executed within a transaction session).
 * Checks existing phone variants including ARCHIVED customers.
 */
export const importCustomers = async (req, res) => {
  const rawCsv = typeof req.body === 'string' ? req.body : (req.body?.csv || '');
  if (!rawCsv.trim()) {
    throw badRequest('CSV content is required in request body');
  }

  const rows = parseCsvRows(rawCsv);
  const { validCustomers, errors } = validateCustomerCsvRows(rows);

  if (errors.length > 0) {
    const err = badRequest('CSV validation failed. Fix the errors and retry.', 'CSV_VALIDATION_ERROR');
    err.data = { errors };
    throw err;
  }

  // Check for duplicate phones against existing database records (including ARCHIVED customers)
  const allVariants = new Set();
  const phoneToRowsMap = new Map();

  for (const c of validCustomers) {
    const variants = phoneVariants(c.customerData.phone);
    for (const v of variants) {
      allVariants.add(v);
      const list = phoneToRowsMap.get(v) || [];
      list.push(c);
      phoneToRowsMap.set(v, list);
    }
  }

  // Query ALL existing customers (archived included)
  const existingDocs = await Customer.find({ phone: { $in: Array.from(allVariants) } }).lean();

  if (existingDocs.length > 0) {
    const dbDupErrors = [];
    const seenRowErrors = new Set();

    for (const doc of existingDocs) {
      const matchingRows = phoneToRowsMap.get(doc.phone) || [];
      for (const row of matchingRows) {
        const errorKey = `${row.rowNumber}:${row.customerData.phone}`;
        if (!seenRowErrors.has(errorKey)) {
          seenRowErrors.add(errorKey);
          const message = doc.isArchived
            ? `Phone number "${row.customerData.phone}" belongs to an archived customer in the shop`
            : `Phone number "${row.customerData.phone}" already exists in the shop`;
          dbDupErrors.push({
            row: row.rowNumber,
            field: 'phone',
            message,
          });
        }
      }
    }

    if (dbDupErrors.length > 0) {
      const err = badRequest(
        'CSV contains phone numbers that already exist in the shop',
        'DUPLICATE_PHONE_IN_CSV'
      );
      err.data = { errors: dbDupErrors };
      throw err;
    }
  }

  // Insert within a transaction session
  const session = await mongoose.startSession();
  session.startTransaction();
  let inserted;

  try {
    const docsToInsert = validCustomers.map((c) => c.customerData);
    inserted = await Customer.insertMany(docsToInsert, { session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await audit.record({
    action: 'customer.import',
    entity: 'Customer',
    after: { count: inserted.length },
  });

  res.status(201).json({
    success: true,
    message: `Successfully imported ${inserted.length} customers`,
    count: inserted.length,
  });
};

/**
 * Get tenant loyalty settings (or defaults).
 */
export const getLoyaltySettingsController = async (req, res) => {
  const settings = await LoyaltySettings.findOne().lean();
  res.json({
    success: true,
    data: settings || DEFAULT_LOYALTY_SETTINGS,
  });
};

/**
 * Update tenant loyalty settings.
 * Validates with Number.isFinite and caps (pointsPerHundredRupees<=1000, valuePerPointCents<=10000, minRedemptionPoints<=1000000, expiryDays<=3650).
 */
export const updateLoyaltySettingsController = async (req, res) => {
  const body = pick(req.body, ['pointsPerHundredRupees', 'valuePerPointCents', 'minRedemptionPoints', 'expiryDays']);
  const updateData = {};

  if (body.pointsPerHundredRupees !== undefined) {
    const v = Number(body.pointsPerHundredRupees);
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      throw badRequest('pointsPerHundredRupees must be a finite number between 0 and 1000');
    }
    updateData.pointsPerHundredRupees = Math.round(v);
  }
  if (body.valuePerPointCents !== undefined) {
    const v = Number(body.valuePerPointCents);
    if (!Number.isFinite(v) || v < 0 || v > 10000) {
      throw badRequest('valuePerPointCents must be a finite number between 0 and 10000');
    }
    updateData.valuePerPointCents = Math.round(v);
  }
  if (body.minRedemptionPoints !== undefined) {
    const v = Number(body.minRedemptionPoints);
    if (!Number.isFinite(v) || v < 0 || v > 1000000) {
      throw badRequest('minRedemptionPoints must be a finite number between 0 and 1000000');
    }
    updateData.minRedemptionPoints = Math.round(v);
  }
  if (body.expiryDays !== undefined) {
    const v = Number(body.expiryDays);
    if (!Number.isFinite(v) || v < 0 || v > 3650) {
      throw badRequest('expiryDays must be a finite number between 0 and 3650');
    }
    updateData.expiryDays = Math.round(v);
  }

  const before = await LoyaltySettings.findOne().lean();
  const updated = await LoyaltySettings.findOneAndUpdate(
    {},
    { $set: updateData },
    { upsert: true, new: true, runValidators: true }
  );

  await audit.record({
    action: 'loyalty_settings.update',
    entity: 'LoyaltySettings',
    entityId: updated._id,
    before,
    after: updated,
  });

  res.json({
    success: true,
    message: 'Loyalty settings updated successfully',
    data: updated,
  });
};
