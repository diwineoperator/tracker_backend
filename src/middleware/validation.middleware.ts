import type { RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and normalises (trim, coerce, defaults) request input with zod.
 * Parsed values are exposed to controllers through `validated(res)`; a failure
 * throws a ZodError that the error middleware maps to a 400 response.
 * (Express 5 makes `req.query` read-only, hence res.locals.)
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, res, next) => {
    res.locals['validated'] = {
      body: schemas.body?.parse(req.body),
      query: schemas.query?.parse(req.query),
      params: schemas.params?.parse(req.params),
    };
    next();
  };

export function validated<T extends { body?: unknown; query?: unknown; params?: unknown }>(
  res: Response,
): T {
  return res.locals['validated'] as T;
}
