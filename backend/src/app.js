import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './core/config.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import rolesRoutes from './modules/roles/roles.routes.js';
import branchesRoutes from './modules/branches/branches.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import customerRoutes from './modules/customers/customers.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import signupRoutes from './modules/signup/signup.routes.js';
import publicRoutes from './modules/public/public.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import posLedgerRoutes from './modules/pos/routes/ledger.routes.js';
import posSaleRoutes from './modules/pos/routes/sale.routes.js';
import posReturnRoutes from './modules/pos/routes/return.routes.js';
import posCreditRoutes from './modules/pos/routes/credit.routes.js';
import posFinanceRoutes from './modules/pos/routes/finance.routes.js';

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(cors({ origin: config.clientUrl, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  if (config.isDev) app.use(morgan('dev'));

  app.get('/', (req, res) =>
    res.json({
      message: 'Cellivo API is running',
      version: '1.0.0',
      endpoints: {
        health: '/api/health', auth: '/api/auth', users: '/api/users', roles: '/api/roles',
        branches: '/api/branches', audit: '/api/audit', customers: '/api/customers',
        billing: '/api/billing', signup: '/api/signup', public: '/api/public', admin: '/api/admin',
      },
    })
  );

  app.use('/api/health', healthRoutes);
  app.use(
    '/api/auth',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: config.authRateLimitMax, standardHeaders: true, legacyHeaders: false }),
    authRoutes
  );
  app.use('/api/users', usersRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/branches', branchesRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/customers', customerRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/signup', signupRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/admin', rateLimit({ windowMs: 15 * 60 * 1000, limit: config.authRateLimitMax, standardHeaders: true, legacyHeaders: false }), adminRoutes);
  app.use('/api/pos/ledger', posLedgerRoutes);
  app.use('/api/pos/sales', posSaleRoutes);
  app.use('/api/pos/returns', posReturnRoutes);
  app.use('/api/pos/credit', posCreditRoutes);
  app.use('/api/pos/finance', posFinanceRoutes);
  app.use('/api/pos', posSaleRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
