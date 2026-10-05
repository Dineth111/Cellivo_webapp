import express from 'express';
import Branch from './Branch.model.js';
import { protect } from '../../core/auth.js';
import { requirePermission, hasSpecial } from '../../core/permissions.js';
import { wrap, badRequest, notFound } from '../../core/errors.js';
import { str, requireId } from '../../core/validate.js';
import { subscriptionGuard, assertBranchLimit } from '../plans/planLimits.js';
import audit from '../../core/audit.js';

const router = express.Router();
router.use(protect, subscriptionGuard);

// GET /api/branches: the branches the user may access (all for roles with view_all_branches).
router.get(
  '/',
  requirePermission('branches.view'),
  wrap(async (req, res) => {
    const filter = hasSpecial(req.auth.role, 'view_all_branches') ? {} : { _id: { $in: req.auth.branchIds } };
    const data = await Branch.find(filter).sort({ name: 1 });
    res.json({ success: true, count: data.length, data });
  })
);

const fields = (b = {}) => ({ name: str(b.name), invoicePrefix: str(b.invoicePrefix), address: str(b.address), phone: str(b.phone) });
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// POST /api/branches: create, up to the plan limit (BR-01, FRS V-09)
router.post(
  '/',
  requirePermission('branches.create'),
  wrap(async (req, res) => {
    const f = fields(req.body);
    if (!f.name || !f.invoicePrefix) throw badRequest('Branch name and invoice prefix are required');
    await assertBranchLimit(req.tenant);
    const branch = await Branch.create(defined(f));
    await audit.record({ action: 'branch.create', entity: 'Branch', entityId: branch._id, after: branch });
    res.status(201).json({ success: true, data: branch });
  })
);

// PUT /api/branches/:id: edit; re-activating a branch counts against the plan limit again
router.put(
  '/:id',
  requirePermission('branches.edit'),
  wrap(async (req, res) => {
    requireId(req.params.id, 'branch id');
    const branch = await Branch.findById(req.params.id);
    if (!branch) throw notFound('Branch not found');
    const before = branch.toObject();
    branch.set(defined(fields(req.body)));
    if (typeof req.body?.isActive === 'boolean' && req.body.isActive !== branch.isActive) {
      if (req.body.isActive) await assertBranchLimit(req.tenant);
      branch.isActive = req.body.isActive;
    }
    await branch.save();
    await audit.record({ action: 'branch.update', entity: 'Branch', entityId: branch._id, before, after: branch });
    res.json({ success: true, data: branch });
  })
);

export default router;
