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

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
