import { Router } from 'express';
import { validate } from '../../middleware/validation.middleware';
import type { MemberController } from './member.controller';
import { createMemberSchema, memberIdSchema, updateMemberSchema } from './member.validation';

/** Mounted behind authenticate + requireAdmin in app.ts. */
export function createMemberRouter(controller: MemberController): Router {
  const router = Router();
  router.get('/', controller.list);
  router.post('/', validate(createMemberSchema), controller.create);
  router.patch('/:id', validate(updateMemberSchema), controller.update);
  router.get('/:id/impact', validate(memberIdSchema), controller.impact);
  router.delete('/:id', validate(memberIdSchema), controller.remove);
  return router;
}
