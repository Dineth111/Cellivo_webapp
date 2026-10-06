import Customer from './Customer.model.js';
import { conflict, notFound, AppError } from '../../core/errors.js';
import { str, pick, requireId, escapeRegex } from '../../core/validate.js';
import audit from '../../core/audit.js';

const FIELDS = ['name', 'phone', 'email', 'address', 'nic', 'type', 'notes'];

// Only whitelisted string fields; anything else in the body (tenantId, isArchived, ...) is ignored.
const clean = (body) =>
  Object.fromEntries(Object.entries(pick(body, FIELDS)).filter(([, v]) => typeof v === 'string'));

async function duplicatePhone(phone, exceptId) {
  const existing = await Customer.findOne({ phone, ...(exceptId && { _id: { $ne: exceptId } }) });
  if (!existing) return;
  const err = new AppError(409, 'A customer with this phone number already exists', 'DUPLICATE_PHONE');
  err.data = existing;
  throw err;
}

export const getCustomers = async (req, res) => {
  const filter = { isArchived: req.query.archived === 'true' };
  const search = str(req.query.search);
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: re }, { phone: re }, { email: re }, { nic: re }];
  }
  const type = str(req.query.type);
  if (type && type !== 'all') filter.type = type;
  const customers = await Customer.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, count: customers.length, data: customers });
};

export const getCustomerById = async (req, res) => {
  requireId(req.params.id);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw notFound('Customer not found');
  res.json({ success: true, data: customer });
};

export const createCustomer = async (req, res) => {
  const data = clean(req.body);
  if (data.phone) await duplicatePhone(data.phone);
  const customer = await Customer.create(data);
  await audit.record({ action: 'customer.create', entity: 'Customer', entityId: customer._id, after: customer });
  res.status(201).json({ success: true, message: 'Customer created successfully', data: customer });
};

export const updateCustomer = async (req, res) => {
  requireId(req.params.id);
  const data = clean(req.body);
  if (data.phone) await duplicatePhone(data.phone, req.params.id);
  const before = await Customer.findById(req.params.id);
  if (!before) throw notFound('Customer not found');
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id }, data, { new: true, runValidators: true });
  await audit.record({ action: 'customer.update', entity: 'Customer', entityId: customer._id, before, after: customer });
  res.json({ success: true, message: 'Customer updated successfully', data: customer });
};

// Customers are archived, never hard-deleted (they stay on historic invoices).
export const deleteCustomer = async (req, res) => {
  requireId(req.params.id);
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, isArchived: false }, { isArchived: true }, { new: true });
  if (!customer) throw notFound('Customer not found');
  await audit.record({ action: 'customer.archive', entity: 'Customer', entityId: customer._id });
  res.json({ success: true, message: 'Customer archived successfully', id: req.params.id });
};
