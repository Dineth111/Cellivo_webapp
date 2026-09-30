import express from 'express';
import {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from './customers.controller.js';
import { protect } from '../../core/auth.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getCustomers).post(createCustomer);
router.route('/:id').get(getCustomerById).put(updateCustomer).delete(deleteCustomer);

export default router;
