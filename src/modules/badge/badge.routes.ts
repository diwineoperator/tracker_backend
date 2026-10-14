import { Router } from 'express';
import { validate } from '../../middleware/validation.middleware';
import type { BadgeController } from './badge.controller';
import { memberBadgesSchema, staffBadgesSchema } from './badge.validation';

/** Mounted behind authenticate + requireMember. */
export function createMemberBadgeRouter(controller: BadgeController): Router {
  const router = Router();
  router.get('/', validate(memberBadgesSchema), controller.member);
  return router;
}

/** Mounted behind authenticate + requireStaff: counts only what the caller's scope covers. */
export function createStaffBadgeRouter(controller: BadgeController): Router {
  const router = Router();
  router.get('/', validate(staffBadgesSchema), controller.staff);
  return router;
}
