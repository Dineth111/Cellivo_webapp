import mongoose from 'mongoose';

export const getHealth = (req, res) => {
  const readyState = mongoose.connection.readyState;
  const states = {
    0: 'Disconnected',
    1: 'Connected',
    2: 'Connecting',
    3: 'Disconnecting',
  };

  const isDbConnected = readyState === 1;

  res.status(isDbConnected ? 200 : 503).json({
    status: isDbConnected ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: {
      status: states[readyState] || 'Unknown',
      readyState,
      host: mongoose.connection.host || 'none',
      name: mongoose.connection.name || 'none',
    },
    server: {
      nodeVersion: process.version,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
};
