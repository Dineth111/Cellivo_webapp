import { Router } from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import * as loyaltyService from '../services/loyalty.service.js';
import { getLoyaltySettings } from '../adapters/loyaltySettings.adapter.js';

const router = Router();

router.use(protect);
router.use(subscriptionGuard);

/**
 * GET /api/pos/loyalty/customer/:customerId
 * Get customer loyalty points balance and history.
 */
router.get('/customer/:customerId', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { customerId } = req.params;

    const data = await loyaltyService.getCustomerLoyaltyHistory(tenantId, customerId);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/pos/loyalty/calculate-redemption
 * Preview points-to-currency value.
 */
router.post('/calculate-redemption', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { customerId, pointsToRedeem } = req.body;

    const validation = await loyaltyService.validateRedemption(tenantId, customerId, pointsToRedeem);
    res.json({ status: 'success', data: validation });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pos/loyalty/settings
 * Get current loyalty settings.
 */
router.get('/settings', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const settings = await getLoyaltySettings(tenantId);
    res.json({ status: 'success', data: settings });
  } catch (err) {
    next(err);
  }
});

export default router;
