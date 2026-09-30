import { getContext } from './tenantContext.js';
import { forbidden } from './errors.js';

export const MODULES = [
  'dashboard', 'pos', 'returns', 'inventory', 'purchases', 'repairs', 'customers',
  'finance', 'cash_drawer', 'staff', 'payroll', 'branches', 'reports', 'settings',
];
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'];
export const SPECIALS = [
  'view_cost_margin', 'override_price', 'approve_discount', 'void_invoice',
  'approve_return', 'adjust_stock', 'view_all_branches', 'export_reports',
];

/** Does this role (plain object or doc) allow "module.action"? Owner always passes. */
export function hasPermission(role, key) {
  if (!role) return false;
  if (role.key === 'owner') return true;
  const [mod, action] = key.split('.');
  return role.grid?.[mod]?.[action] === true;
}

export const hasSpecial = (role, name) => !!role && (role.key === 'owner' || role.special?.[name] === true);

const roleOf = () => getContext()?.role;

/** Route guard: requirePermission('pos.create'). Checked on the server, per request. */
export const requirePermission = (key) => {
  const [mod, action] = key.split('.');
  if (!MODULES.includes(mod) || !ACTIONS.includes(action)) throw new Error(`Unknown permission "${key}"`);
  return (req, res, next) => (hasPermission(roleOf(), key) ? next() : next(forbidden()));
};

/** Route guard for special permissions: requireSpecial('view_cost_margin'). */
export const requireSpecial = (name) => {
  if (!SPECIALS.includes(name)) throw new Error(`Unknown special permission "${name}"`);
  return (req, res, next) => (hasSpecial(roleOf(), name) ? next() : next(forbidden()));
};

/** Owner-only routes (roles, sessions of the whole tenant, audit log). */
export const requireOwner = (req, res, next) => (roleOf()?.key === 'owner' ? next() : next(forbidden('Owner access required')));
