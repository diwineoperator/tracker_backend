import { Router } from 'express';
import { validate } from '../../middleware/validation.middleware';
import type { TimeTrackerController } from './time-tracker.controller';
import {
  activityHistoryQuerySchema,
  createTrackerSchema,
  memberActivityHistoryQuerySchema,
  memberIdParamsSchema,
  trackerIdSchema,
  updateTrackerSchema,
} from './time-tracker.validation';

/** Mounted behind authenticate + requireMember: a member's own ledger only. */
export function createTimeTrackerRouter(controller: TimeTrackerController): Router {
  const router = Router();
  router.post('/', validate(createTrackerSchema), controller.create);
  router.get('/today', controller.today);
  router.post('/close-day', controller.closeDay);
  // Must come before `/:id` — otherwise "history" would match as a tracker id.
  router.get('/history', validate(memberActivityHistoryQuerySchema), controller.memberActivityHistory);
  router.get('/:id', validate(trackerIdSchema), controller.getOne);
  router.patch('/:id', validate(updateTrackerSchema), controller.update);
  router.delete('/:id', validate(trackerIdSchema), controller.remove);
  return router;
}

/** Mounted behind authenticate + requireAdmin: read/edit/delete across every member's ledger. */
export function createAdminTimeTrackerRouter(controller: TimeTrackerController): Router {
  const router = Router();
  router.get('/', controller.overview);
  router.get('/members/:memberId', validate(memberIdParamsSchema), controller.todayForMember);
  // Must come before `/:id` — otherwise "history" would match as a tracker id.
  router.get('/history', validate(activityHistoryQuerySchema), controller.activityHistory);
  router.get('/:id', validate(trackerIdSchema), controller.adminGetOne);
  router.patch('/:id', validate(updateTrackerSchema), controller.adminUpdate);
  router.delete('/:id', validate(trackerIdSchema), controller.adminRemove);
  return router;
}
