import express from 'express';
import * as c from './auth.controller.js';
import { protect } from '../../core/auth.js';
import { requireOwner } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';

const router = express.Router();

router.post('/register', wrap(c.register));
router.post('/login', wrap(c.login));
router.post('/refresh', wrap(c.refresh));
router.post('/forgot-password', wrap(c.forgotPassword));
router.post('/reset-password', wrap(c.consume('reset')));
router.post('/set-password', wrap(c.consume('invite')));

router.use(protect);
router.post('/logout', wrap(c.logout));
router.get('/me', wrap(c.getMe));
router.put('/profile', wrap(c.updateProfile));
router.put('/change-password', wrap(c.changePassword));
router.get('/sessions', wrap(c.mySessions));
router.get('/sessions/tenant', requireOwner, wrap(c.tenantSessions));
router.delete('/sessions/:id', wrap(c.revoke));

export default router;
