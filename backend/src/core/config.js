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
  bcryptCost: env.NODE_ENV === 'test' ? 4 : 12,
  isDev: env.NODE_ENV === 'development',
};

// Called at startup: the server must not run with a missing secret.
export function assertConfig() {
  const missing = ['JWT_SECRET', 'MONGO_URI'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}
