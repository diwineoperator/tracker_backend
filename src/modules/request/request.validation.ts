import { z } from 'zod';
import { REQUEST_STATUSES } from './request.types';

// eslint-disable-next-line no-control-regex
const noControlChars = /^[^\u0000-\u001F\u007F]*$/;

const subject = z
  .string({ error: 'Subject is required.' })
  .trim()
  .min(1, 'Subject is required.')
  .max(200, 'Subject must be at most 200 characters.')
  .regex(noControlChars, 'Subject contains invalid characters.');

const message = z.string({ error: 'Message is required.' }).trim().min(1, 'Message is required.').max(2000, 'Message must be at most 2000 characters.');

// An empty reply clears it (stored as NULL), like the task description.
const response = z
  .string()
  .trim()
  .max(1000, 'Reply must be at most 1000 characters.')
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

const status = z.enum(REQUEST_STATUSES, { error: 'Invalid status.' });

const idParams = z.object({ id: z.uuid('Invalid request id.') });

export const sendRequestSchema = { body: z.object({ toDepartmentId: z.uuid('Choose a department.'), subject, message }) };

export const updateRequestSchema = {
  params: idParams,
  body: z.object({ status: status.optional(), response }).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' }),
};

export const listInboxSchema = { query: z.object({ status: status.optional() }) };

// A follow-up message in the conversation — same length limit as the original ask.
export const sendMessageSchema = { params: idParams, body: z.object({ body: message }) };

export type SendRequestBody = z.infer<typeof sendRequestSchema.body>;
export type UpdateRequestParams = z.infer<typeof updateRequestSchema.params>;
export type UpdateRequestBody = z.infer<typeof updateRequestSchema.body>;
export type ListInboxQuery = z.infer<typeof listInboxSchema.query>;
export type SendMessageParams = z.infer<typeof sendMessageSchema.params>;
export type SendMessageBody = z.infer<typeof sendMessageSchema.body>;
