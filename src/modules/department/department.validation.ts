import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const noControlChars = /^[^\u0000-\u001F\u007F]*$/;

const name = z
  .string({ error: 'Department name is required.' })
  .trim()
  .min(1, 'Department name is required.')
  .max(100, 'Department name must be at most 100 characters.')
  .regex(noControlChars, 'Department name contains invalid characters.');

const idParams = z.object({ id: z.uuid('Invalid department id.') });

// A department starts with no leader — one is assigned afterward, from its existing members.
export const createDepartmentSchema = { body: z.object({ name }) };

// Assigns (or changes) a department's leader: promotes an EXISTING member of that department to
// Admin. A brand-new account is never created here — that's what `POST /members` is for.
export const assignLeaderSchema = { params: idParams, body: z.object({ memberId: z.uuid('Select a member.') }) };

export const updateDepartmentSchema = {
  params: idParams,
  body: z
    .object({ name: name.optional(), isActive: z.boolean().optional() })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' }),
};

export const departmentIdSchema = { params: idParams };

export type CreateDepartmentBody = z.infer<typeof createDepartmentSchema.body>;
export type AssignLeaderBody = z.infer<typeof assignLeaderSchema.body>;
export type UpdateDepartmentParams = z.infer<typeof updateDepartmentSchema.params>;
export type UpdateDepartmentBody = z.infer<typeof updateDepartmentSchema.body>;
export type DepartmentIdParams = z.infer<typeof idParams>;
