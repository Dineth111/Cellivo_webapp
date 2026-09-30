import { config, assertConfig } from './core/config.js';
import connectDB from './core/db.js';
import { createApp } from './app.js';

// Fail closed: never start with missing secrets.
try {
  assertConfig();
} catch (err) {
  console.error(`${err.message}. Refusing to start.`);
  process.exit(1);
}

try {
  await connectDB();
} catch (err) {
  console.error(`[MongoDB Connection Error]: ${err.message}`);
  process.exit(1);
}

createApp().listen(config.port, () => {
  console.log(`⚡ Server running in ${config.env} mode on port ${config.port}`);
  console.log(`🔗 API Base: http://localhost:${config.port}`);
});
