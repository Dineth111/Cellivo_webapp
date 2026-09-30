const isDev = () => process.env.NODE_ENV === 'development';

export const errorHandler = (err, req, res, next) => {
  console.error('[Error Details]:', err);

  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  let message = statusCode >= 500 && !isDev() ? 'Internal Server Error' : err.message || 'Internal Server Error';

  // Handle Mongoose Bad ObjectId CastError
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 400;
    message = 'Resource not found (Invalid ID format)';
  }

  // Handle Mongoose Validation Error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
  }

  // Handle Duplicate Key Error (code 11000): never reveal which field outside development
  if (err.code === 11000) {
    statusCode = 409;
    message = isDev()
      ? `Duplicate value entered for ${Object.keys(err.keyValue || {})[0]} field. It must be unique.`
      : 'A record with these details already exists.';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(isDev() && { stack: err.stack }),
  });
};
