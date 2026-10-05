import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT) || 5000,
  mongoUri: env.MONGO_URI,
  jwtSecret: env.JWT_SECRET,
  accessTokenTtl: env.ACCESS_TOKEN_TTL || '15m',
  clientUrl: env.CLIENT_URL || 'http://localhost:3000',
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  authRateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX) || 100,
  trialDays: Number(env.TRIAL_DAYS) || 14,
  // billing (Dev 2). Retries run on days 1, 3 and 5; suspension after SUSPEND_AFTER_DAYS (FRS F-02, configurable)
  paymentGateway: env.PAYMENT_GATEWAY || 'test',
  suspendAfterDays: Number(env.SUSPEND_AFTER_DAYS) || 7,
  subscriptionTaxPercent: Number(env.SUBSCRIPTION_TAX_PERCENT) || 0,
  billingJobMinutes: env.BILLING_JOB_MINUTES === undefined ? 60 : Number(env.BILLING_JOB_MINUTES), // 0 = off
  // platform admin (Dev 2). Empty list = any IP (development). Comma separated, exact IPs.
  adminIpAllowList: (env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  bcryptCost: env.NODE_ENV === 'test' ? 4 : 12,
  isDev: env.NODE_ENV === 'development',
};

// Called at startup: the server must not run with a missing secret.
export function assertConfig() {
  const missing = ['JWT_SECRET', 'MONGO_URI'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}
