import express from 'express';
import {
  register,
  login,
  getMe,
  updateProfile,
} from './auth.controller.js';
import { protect } from '../../core/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);

export default router;
