import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiFailure } from '../utils/api-response';
import { AppError, Errors } from '../utils/errors';
import { logger } from '../utils/logger';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.routeNotFound());

/** Single place that turns any thrown value into the API error envelope. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = Errors.validation(
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  } else if (err?.type === 'entity.parse.failed') {
    appError = Errors.invalidJson();
  } else if (err?.type === 'entity.too.large') {
    appError = new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  } else {
    // Unexpected: log the technical detail, return a generic message. Never
    // leak stack traces, SQL or driver errors to the client.
    logger.error('Unhandled error', err, { method: req.method, path: req.originalUrl.split('?')[0] });
    appError = Errors.internal();
  }

  const body: ApiFailure = {
    success: false,
    message: appError.message,
    code: appError.code,
    ...(appError.details !== undefined && { details: appError.details }),
  };
  res.status(appError.statusCode).json(body);
};
