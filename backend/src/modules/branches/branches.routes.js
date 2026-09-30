import express from 'express';
import Branch from './Branch.model.js';
import { protect } from '../../core/auth.js';
import { requirePermission, hasSpecial } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';

const router = express.Router();
router.use(protect);

// GET /api/branches: the branches the user may access (all for roles with view_all_branches).
// TODO(Dev 1, later): create/edit branches with the plan-limit check (BR-01).
router.get(
  '/',
  requirePermission('branches.view'),
  wrap(async (req, res) => {
    const filter = hasSpecial(req.auth.role, 'view_all_branches') ? {} : { _id: { $in: req.auth.branchIds } };
    const data = await Branch.find(filter).sort({ name: 1 });
    res.json({ success: true, count: data.length, data });
  })
);

export default router;
