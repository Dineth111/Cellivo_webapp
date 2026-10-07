import { MODULES, ACTIONS, SPECIALS } from '../../core/permissions.js';

// SRS Appendix B + Figure 10.17. Letters: v=view c=create e=edit d=delete a=approve.
const LETTER = { v: 'view', c: 'create', e: 'edit', d: 'delete', a: 'approve' };

// tradeInLimitCents is an assumption (OPEN_QUESTIONS.md 24). The owner's value is ignored: no limit.
const build = (key, name, grants, specials, discountLimitPercent, tradeInLimitCents = 0) => ({
  key,
  name,
  isSystem: true,
  discountLimitPercent,
  tradeInLimitCents,
  grid: Object.fromEntries(
    MODULES.map((m) => [m, Object.fromEntries(ACTIONS.map((a) => [a, [...(grants[m] || '')].some((l) => LETTER[l] === a)]))])
  ),
  special: Object.fromEntries(SPECIALS.map((s) => [s, specials.includes(s)])),
});

const FULL = 'vceda';

export const DEFAULT_ROLES = [
  build('owner', 'Owner', Object.fromEntries(MODULES.map((m) => [m, FULL])), SPECIALS, 100),
  build(
    'branch_manager',
    'Branch Manager',
    {
      dashboard: 'v', pos: FULL, returns: 'vcea', inventory: FULL, purchases: 'vce', repairs: FULL,
      customers: 'vce', cash_drawer: FULL, staff: 'v', branches: 'v', reports: 'v', settings: 've',
    },
    ['view_cost_margin', 'approve_discount', 'void_invoice', 'approve_return', 'adjust_stock', 'export_reports'],
    20,
    5_000_000 // Rs 50,000
  ),
  build(
    'cashier',
    'Cashier',
    { dashboard: 'v', pos: 'vc', returns: 'vc', inventory: 'v', repairs: 'vc', customers: 'vce', cash_drawer: 'vc' },
    [],
    5
  ),
  build('technician', 'Technician', { dashboard: 'v', inventory: 'v', repairs: 've' }, [], 0),
  build(
    'accountant',
    'Accountant',
    {
      dashboard: 'v', pos: 'v', returns: 'v', inventory: 'v', purchases: 'vce', repairs: 'v', customers: 'v',
      finance: FULL, cash_drawer: FULL, payroll: FULL, reports: 'v',
    },
    ['view_cost_margin', 'export_reports'],
    0
  ),
];
