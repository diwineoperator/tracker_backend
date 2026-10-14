import { z } from 'zod';
import { isValidLocalDate } from '../../utils/time';
import { TASK_STATUSES } from './task.types';

const title = z.string({ error: 'Title is required.' }).trim().min(1, 'Title is required.').max(200, 'Title must be at most 200 characters.');

// Empty text clears the description (stored as NULL), matching how the tracker's optional comment behaves.
const description = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters.')
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

const dueDate = z
  .string()
  .refine(isValidLocalDate, 'Enter a valid due date.')
  .nullable()
  .optional();

const status = z.enum(TASK_STATUSES, { error: 'Invalid status.' });

const idParams = z.object({ id: z.uuid('Invalid task id.') });

export const createTaskSchema = {
  body: z.object({
    title,
    description,
    // Required when assigning to a MEMBER (which of their 1-2 departments); derived server-side —
    // and never trusted from the client — when assigning to another department's LEADER.
    departmentId: z.uuid('Select a department.').optional(),
    memberId: z.uuid('Select who this is for.'),
    status: status.optional(),
    dueDate,
  }),
};

export const updateTaskSchema = {
  params: idParams,
  body: z
    .object({
      title: title.optional(),
      description,
      departmentId: z.uuid('Select a department.').optional(),
      memberId: z.uuid('Select a member.').optional(),
      status: status.optional(),
      dueDate,
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' }),
};

// A member may change one thing about their own task: its progress. `.strict()` rejects anything else.
export const updateMyTaskStatusSchema = {
  params: idParams,
  body: z.object({ status }).strict(),
};

export const taskIdSchema = { params: idParams };

export const listTasksSchema = {
  query: z.object({
    departmentId: z.uuid('Invalid department id.').optional(),
    memberId: z.uuid('Invalid member id.').optional(),
    status: status.optional(),
  }),
};

export type CreateTaskBody = z.infer<typeof createTaskSchema.body>;
export type UpdateTaskParams = z.infer<typeof updateTaskSchema.params>;
export type UpdateTaskBody = z.infer<typeof updateTaskSchema.body>;
export type UpdateMyTaskStatusBody = z.infer<typeof updateMyTaskStatusSchema.body>;
export type TaskIdParams = z.infer<typeof idParams>;
export type ListTasksQuery = z.infer<typeof listTasksSchema.query>;
