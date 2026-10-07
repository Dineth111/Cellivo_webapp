import Role from './Role.model.js';
import User from '../users/User.model.js';
import { MODULES, ACTIONS, SPECIALS } from '../../core/permissions.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { str, requireId } from '../../core/validate.js';
import audit from '../../core/audit.js';
import { hasFeature, planOf, featureError } from '../plans/planLimits.js';

// Only known modules/actions with boolean values get through; everything else in the body is ignored.
function cleanInput(b = {}) {
  const set = {};
  const name = str(b.name);
  if (name !== undefined) set.name = name;
  for (const m of MODULES) for (const a of ACTIONS) if (typeof b.grid?.[m]?.[a] === 'boolean') set[`grid.${m}.${a}`] = b.grid[m][a];
  for (const s of SPECIALS) if (typeof b.special?.[s] === 'boolean') set[`special.${s}`] = b.special[s];
  if (b.discountLimitPercent !== undefined) {
    const n = Number(b.discountLimitPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('Discount limit must be between 0 and 100');
    set.discountLimitPercent = n;
  }
  if (b.tradeInLimitCents !== undefined) {
    const n = b.tradeInLimitCents;
    if (!Number.isSafeInteger(n) || n < 0) throw badRequest('Trade-in limit must be a whole number of cents, 0 or more');
    set.tradeInLimitCents = n;
  }
  return set;
}

const load = async (id) => {
  requireId(id, 'role id');
  const role = await Role.findById(id);
  if (!role) throw notFound('Role not found');
  return role;
};

export const list = async (req, res) => {
  const roles = await Role.find().sort({ isSystem: -1, name: 1 });
  res.json({ success: true, count: roles.length, data: roles });
};

export const get = async (req, res) => res.json({ success: true, data: await load(req.params.id) });

export const create = async (req, res) => {
  if (!hasFeature(await planOf(req.tenant), 'custom_roles')) throw await featureError('custom_roles'); // Starter+ (FRS F-04)
  const set = cleanInput(req.body);
  if (!set.name) throw badRequest('Role name is required');
  const role = new Role();
  for (const [k, v] of Object.entries(set)) role.set(k, v);
  await role.save();
  await audit.record({ action: 'role.create', entity: 'Role', entityId: role._id, after: role });
  res.status(201).json({ success: true, data: role });
};

export const update = async (req, res) => {
  const role = await load(req.params.id);
  if (role.key === 'owner') throw badRequest('The Owner role cannot be modified');
  const before = role.toObject();
  const set = cleanInput(req.body);
  if (role.isSystem) delete set.name; // default roles keep their names
  for (const [k, v] of Object.entries(set)) role.set(k, v);
  await role.save();
  await audit.record({ action: 'role.update', entity: 'Role', entityId: role._id, before, after: role });
  res.json({ success: true, data: role });
};

export const remove = async (req, res) => {
  const role = await load(req.params.id);
  if (role.isSystem) throw badRequest('Default roles cannot be deleted');
  if (await User.exists({ roleId: role._id })) throw conflict('This role is assigned to users. Reassign them first.');
  await Role.deleteOne({ _id: role._id });
  await audit.record({ action: 'role.delete', entity: 'Role', entityId: role._id, before: role });
  res.json({ success: true, message: 'Role deleted' });
};
