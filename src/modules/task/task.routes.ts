import { Router } from 'express';
import { validate } from '../../middleware/validation.middleware';
import type { TaskController } from './task.controller';
import { createTaskSchema, listTasksSchema, taskIdSchema, updateMyTaskStatusSchema, updateTaskSchema } from './task.validation';

/** Mounted behind authenticate + requireWorker (a member, or a leader acting on their own): only ever the caller's own tasks. */
export function createMemberTaskRouter(controller: TaskController): Router {
  const router = Router();
  router.get('/', controller.mine);
  router.patch('/:id/status', validate(updateMyTaskStatusSchema), controller.updateMyStatus);
  router.post('/:id/timer', validate(taskIdSchema), controller.startTimer);
  router.delete('/:id/timer', validate(taskIdSchema), controller.discardTimer);
  return router;
}

/** Mounted behind authenticate + requireStaff: a leader only ever sees and changes their own department's tasks. */
export function createAdminTaskRouter(controller: TaskController): Router {
  const router = Router();
  router.get('/', validate(listTasksSchema), controller.list);
  router.post('/', validate(createTaskSchema), controller.create);
  router.patch('/:id', validate(updateTaskSchema), controller.update);
  router.delete('/:id', validate(taskIdSchema), controller.remove);
  return router;
}
