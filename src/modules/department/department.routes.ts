import { Router } from 'express';
import { validate } from '../../middleware/validation.middleware';
import type { DepartmentController } from './department.controller';
import { requireSuperAdmin } from '../../middleware/auth.middleware';
import { assignLeaderSchema, createDepartmentSchema, departmentIdSchema, updateDepartmentSchema } from './department.validation';

/** Mounted behind authenticate + requireStaff in app.ts: a leader may only READ (their own department); every change is the super admin's. */
export function createDepartmentRouter(controller: DepartmentController): Router {
  const router = Router();
  router.get('/', controller.list);
  // Literal path, so it never collides with the `/:id/...` routes below. Any staff caller — a task
  // assignment picker's data, not department management.
  router.get('/leaders', controller.leaderTargets);
  router.post('/', requireSuperAdmin, validate(createDepartmentSchema), controller.create);
  // Assigns/changes the leader (promotes an existing member) — PUT is idempotent-in-intent ("set the leader to X").
  router.put('/:id/leader', requireSuperAdmin, validate(assignLeaderSchema), controller.assignLeader);
  router.delete('/:id/leader', requireSuperAdmin, validate(departmentIdSchema), controller.removeLeader);
  router.patch('/:id', requireSuperAdmin, validate(updateDepartmentSchema), controller.update);
  router.get('/:id/impact', requireSuperAdmin, validate(departmentIdSchema), controller.impact);
  router.delete('/:id', requireSuperAdmin, validate(departmentIdSchema), controller.remove);
  return router;
}
