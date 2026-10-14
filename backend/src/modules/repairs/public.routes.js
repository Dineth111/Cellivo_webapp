import express from 'express';
import { wrap } from '../../core/errors.js';
import { getPublicRepairStatus } from './public.controller.js';

const router = express.Router();

// GET and POST /api/public/repairs/status
router.get('/status', wrap(getPublicRepairStatus));
router.post('/status', wrap(getPublicRepairStatus));

export default router;
