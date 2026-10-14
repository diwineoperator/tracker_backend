import { Router } from 'express';
import { readFileBody, type AttachmentController } from '../attachment/attachment.controller';
import { validate } from '../../middleware/validation.middleware';
import type { RequestController } from './request.controller';
import { listInboxSchema, sendMessageSchema, sendRequestSchema, updateRequestSchema } from './request.validation';

/** Mounted behind authenticate + requireMember: send a request, and read only your own. */
export function createMemberRequestRouter(controller: RequestController, files: AttachmentController): Router {
  const router = Router();
  router.get('/targets', controller.targets);
  router.get('/', controller.mine);
  router.post('/', validate(sendRequestSchema), controller.send);
  // The ongoing conversation on my own request, after the original ask.
  router.post('/:id/messages', validate(sendMessageSchema), controller.sendMemberMessage);
  // Files on my own requests (the ones I sent).
  router.post('/:id/attachments', readFileBody, files.memberUpload);
  router.get('/:id/attachments/:attachmentId', files.memberOpen);
  router.delete('/:id/attachments/:attachmentId', files.memberRemove);
  return router;
}

/** Mounted behind authenticate + requireStaff: a leader's inbox is their own department's requests only. */
export function createStaffRequestRouter(controller: RequestController, files: AttachmentController): Router {
  const router = Router();
  router.get('/', validate(listInboxSchema), controller.inbox);
  router.patch('/:id', validate(updateRequestSchema), controller.update);
  // The ongoing conversation on requests in my scope — never blocked by a closed status.
  router.post('/:id/messages', validate(sendMessageSchema), controller.sendStaffMessage);
  // Files on requests in my scope; I attach (and remove) replies.
  router.post('/:id/attachments', readFileBody, files.staffUpload);
  router.get('/:id/attachments/:attachmentId', files.staffOpen);
  router.delete('/:id/attachments/:attachmentId', files.staffRemove);
  return router;
}
