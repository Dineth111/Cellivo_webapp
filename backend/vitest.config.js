import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    fileParallelism: false, // tests share one in-memory replica set
    hookTimeout: 120000,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      MONGO_URI: 'mongodb://unused',
      AUTH_RATE_LIMIT_MAX: '100000',
    },
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/modules/**'],
      exclude: ['src/**/*.routes.js', 'src/modules/health/**'],
      reporter: ['text-summary', 'text'],
    },
  },
});
