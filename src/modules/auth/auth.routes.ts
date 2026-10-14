import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middleware/validation.middleware';
import { Errors } from '../../utils/errors';
import type { AuthController } from './auth.controller';
import { loginSchema } from './auth.validation';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();

  // Brute-force protection: failed attempts count, successful logins do not.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(Errors.tooManyLoginAttempts()),
  });

  router.post('/login', loginLimiter, validate(loginSchema), controller.login);
  return router;
}
