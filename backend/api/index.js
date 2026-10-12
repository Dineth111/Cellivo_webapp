import { assertConfig } from '../src/core/config.js';
import connectDB from '../src/core/db.js';
import { createApp } from '../src/app.js';

// Vercel entry: no listen() and no setInterval jobs (they cannot run serverless).
// shortcut: billing / held-cart jobs don't run here, move them to Vercel Cron when needed.
const app = createApp();
let ready;

export default async function handler(req, res) {
  try {
    assertConfig();
    ready ??= connectDB().catch((e) => { ready = undefined; throw e; });
    await ready;
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ message: 'Server not configured' });
  }
  return app(req, res);
}
