import { config } from './config.js';

// Throw for expected failures; the message is safe to show to the client.
export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export const badRequest = (m, code) => new AppError(400, m, code);
export const unauthorized = (m = 'Not authorized', code) => new AppError(401, m, code);
export const forbidden = (m = 'You do not have permission to do this', code) => new AppError(403, m, code);
export const notFound = (m = 'Not found') => new AppError(404, m);
export const conflict = (m, code) => new AppError(409, m, code);

export const notFoundHandler = (req, res) =>
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl.split('?')[0]}` });

// Wraps async route handlers so rejections reach errorHandler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const errorHandler = (err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : status >= 500 ? 'Internal Server Error' : err.message;

  if (err.name === 'CastError') {
    status = 400;
    message = 'Invalid ID format';
  } else if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.code === 11000) {
    status = 409;
    message = config.isDev
      ? `Duplicate value for ${Object.keys(err.keyValue || {}).join(', ')}. It must be unique.`
      : 'A record with these details already exists.';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  }

  if (status >= 500) console.error('[Error]', err);

  res.status(status).json({
    success: false,
    message,
    ...(typeof err.code === 'string' && { code: err.code }),
    ...(err.data && { data: err.data }),
    ...(config.isDev && status >= 500 && { stack: err.stack }),
  });
};
