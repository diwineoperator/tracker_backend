import type { RequestHandler } from 'express';
import { logger } from '../utils/logger';

/** One line per request: method, path (no query string), status, duration. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });
  next();
};
