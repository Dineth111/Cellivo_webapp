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
import { conflict, notFound, badRequest, AppError } from '../../core/errors.js';
import { str, pick, requireId, escapeRegex, pageParams } from '../../core/validate.js';
import { normalizePhone, phoneVariants } from './utils/phone.js';
import { maskPhone, maskNic } from './utils/mask.js';
import { parseCsvRows, validateCustomerCsvRows } from './utils/csv.js';
import audit from '../../core/audit.js';

const FIELDS = ['name', 'phone', 'email', 'address', 'nic', 'type', 'notes', 'tags', 'marketingOptIn'];

// Clean and whitelist string / array / boolean fields from req.body
const clean = (body) => {
  const p = pick(body, FIELDS);
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'tags' && Array.isArray(v)) {
      out.tags = v.map((t) => String(t).trim()).filter((t) => t.length > 0 && t.length <= 50);
    } else if (k === 'marketingOptIn') {
      out.marketingOptIn = v === true;
    } else if (typeof v === 'string') {
      out[k] = v.trim();
    }
  }
  return out;
};

async function duplicatePhone(phone, exceptId) {
  const variants = phoneVariants(phone);
  const existing = await Customer.findOne({
    phone: { $in: variants },
    isArchived: false,
    ...(exceptId && { _id: { $ne: exceptId } }),
  });
  if (!existing) return;
  const err = new AppError(409, 'A customer with this phone number already exists', 'DUPLICATE_PHONE');
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
    filter.$or = [
      { name: re },
      { phone: { $in: variants.length ? variants : [re] } },
      { email: re },
      { nic: re },
    ];
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

  data.phone = normalizePhone(data.phone);
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

  if (data.phone) {
    data.phone = normalizePhone(data.phone);
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
 * Find likely duplicates across active customers (same normalised phone, NIC, or email).
 */
export const getDuplicates = async (req, res) => {
  const customers = await Customer.find({ isArchived: false }).lean();
  const phoneMap = new Map();
  const nicMap = new Map();
  const emailMap = new Map();

  for (const c of customers) {
    const normPhone = normalizePhone(c.phone);
    if (normPhone) {
      const list = phoneMap.get(normPhone) || [];
      list.push(c);
      phoneMap.set(normPhone, list);
    }
    const cleanNic = (c.nic || '').trim().toUpperCase();
    if (cleanNic) {
      const list = nicMap.get(cleanNic) || [];
      list.push(c);
      nicMap.set(cleanNic, list);
    }
    const cleanEmail = (c.email || '').trim().toLowerCase();
    if (cleanEmail) {
      const list = emailMap.get(cleanEmail) || [];
      list.push(c);
      emailMap.set(cleanEmail, list);
    }
  }

  const duplicateGroups = [];
  const seenGroupKeys = new Set();

  function addGroup(reason, matchedKey, list) {
    if (list.length < 2) return;
    const ids = list.map((c) => String(c._id)).sort().join(':');
    const groupKey = `${reason}:${ids}`;
    if (seenGroupKeys.has(groupKey)) return;
    seenGroupKeys.add(groupKey);

    duplicateGroups.push({
      reason,
      matchedKey,
      count: list.length,
      customers: list.map((c) => ({
        ...c,
        phone: maskPhone(c.phone),
        nic: maskNic(c.nic),
      })),
    });
  }

  for (const [phone, list] of phoneMap.entries()) {
    addGroup('duplicate_phone', phone, list);
  }
  for (const [nic, list] of nicMap.entries()) {
    addGroup('duplicate_nic', nic, list);
  }
  for (const [email, list] of emailMap.entries()) {
    addGroup('duplicate_email', email, list);
  }

  res.json({
    success: true,
    count: duplicateGroups.length,
    data: duplicateGroups,
  });
};

/**
 * Merge two customers inside one atomic transaction.
 * Owner only. Reassigns Dev 3 collections via reassign adapter.
 */
export const mergeCustomers = async (req, res) => {
  const sourceId = requireId(req.params.id, 'source customer id');
  const targetId = requireId(req.body?.intoId, 'intoId');

  if (String(sourceId) === String(targetId)) {
    throw badRequest('Cannot merge a customer into itself');
  }

  const [source, target] = await Promise.all([
    Customer.findById(sourceId),
    Customer.findById(targetId),
  ]);

  if (!source) throw notFound('Source customer not found');
  if (!target) throw notFound('Target customer not found');

  if (!source.tenantId.equals(target.tenantId)) {
    throw notFound('Customer not found');
  }

  if (source.isArchived || source.mergedInto) {
    throw badRequest('Source customer is already archived or merged');
  }
  if (target.isArchived || target.mergedInto) {
    throw badRequest('Target customer is archived or merged');
  }

  let curr = target;
  while (curr && curr.mergedInto) {
    if (curr.mergedInto.equals(source._id)) {
      throw badRequest('Merge would create a circular reference');
    }
    curr = await Customer.findById(curr.mergedInto);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const tenantId = source.tenantId;

    // 1. Reassign references in Dev 3's collections via adapter
    await reassignCustomerData(tenantId, source._id, target._id, session);

    // 2. Consolidate financial & loyalty metrics onto target
    target.currentBalanceCents = (target.currentBalanceCents || 0) + (source.currentBalanceCents || 0);
    target.loyaltyPoints = (target.loyaltyPoints || 0) + (source.loyaltyPoints || 0);
    target.creditLimitCents = Math.max(target.creditLimitCents || 0, source.creditLimitCents || 0);

    // 3. Merge tags
    const combinedTags = Array.from(new Set([...(target.tags || []), ...(source.tags || [])]));
    target.tags = combinedTags;

    // 4. Merge notes
    if (source.notes) {
      if (!target.notes) {
        target.notes = source.notes;
      } else if (!target.notes.includes(source.notes)) {
        target.notes = `${target.notes}\n[Merged note]: ${source.notes}`;
      }
    }

    // 5. Archive source customer with mergedInto pointer
    source.isArchived = true;
    source.mergedInto = target._id;
    source.currentBalanceCents = 0;
    source.loyaltyPoints = 0;

    await target.save({ session });
    await source.save({ session });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await audit.record({
    action: 'customer.merge',
    entity: 'Customer',
    entityId: target._id,
    before: { sourceId: source._id, targetId: target._id },
    after: {
      mergedInto: target._id,
      currentBalanceCents: target.currentBalanceCents,
      loyaltyPoints: target.loyaltyPoints,
      creditLimitCents: target.creditLimitCents,
    },
  });

  res.json({
    success: true,
    message: 'Customers merged successfully',
    data: target,
  });
};

/**
 * Customer history (invoices, payments, credit notes, installment plans, loyalty).
 * Read-only.
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
      invoices,
      payments,
      creditNotes,
      installmentPlans,
      loyaltyTransactions,
      // Placeholder for future modules
      devices: [],
      repairs: [],
    },
    page,
    limit,
  });
};

/**
 * CSV Import (all-or-nothing, per-row validation).
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

  // Check for duplicate phones against existing database records
  const allPhones = validCustomers.map((c) => c.customerData.phone);
  const existingDocs = await Customer.find({ phone: { $in: allPhones }, isArchived: false }).lean();

  if (existingDocs.length > 0) {
    const existingSet = new Set(existingDocs.map((d) => d.phone));
    const dbDupErrors = validCustomers
      .filter((c) => existingSet.has(c.customerData.phone))
      .map((c) => ({
        row: c.rowNumber,
        field: 'phone',
        message: `Phone number "${c.customerData.phone}" already exists in the shop`,
      }));

    const err = badRequest(
      'CSV contains phone numbers that already exist in the shop',
      'DUPLICATE_PHONE_IN_CSV'
    );
    err.data = { errors: dbDupErrors };
    throw err;
  }

  const docsToInsert = validCustomers.map((c) => c.customerData);
  const inserted = await Customer.insertMany(docsToInsert);

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
 */
export const updateLoyaltySettingsController = async (req, res) => {
  const body = pick(req.body, ['pointsPerHundredRupees', 'valuePerPointCents', 'minRedemptionPoints', 'expiryDays']);
  const updateData = {};

  if (body.pointsPerHundredRupees !== undefined) {
    const v = Number(body.pointsPerHundredRupees);
    if (isNaN(v) || v < 0) throw badRequest('pointsPerHundredRupees must be 0 or greater');
    updateData.pointsPerHundredRupees = Math.round(v);
  }
  if (body.valuePerPointCents !== undefined) {
    const v = Number(body.valuePerPointCents);
    if (isNaN(v) || v < 0) throw badRequest('valuePerPointCents must be 0 or greater');
    updateData.valuePerPointCents = Math.round(v);
  }
  if (body.minRedemptionPoints !== undefined) {
    const v = Number(body.minRedemptionPoints);
    if (isNaN(v) || v < 0) throw badRequest('minRedemptionPoints must be 0 or greater');
    updateData.minRedemptionPoints = Math.round(v);
  }
  if (body.expiryDays !== undefined) {
    const v = Number(body.expiryDays);
    if (isNaN(v) || v < 0) throw badRequest('expiryDays must be 0 or greater');
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
