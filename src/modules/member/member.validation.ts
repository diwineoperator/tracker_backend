import { z } from 'zod';
import { MAX_MEMBER_DEPARTMENTS } from './member.types';

// The only password rule besides "not empty" is bcrypt's own 72-byte input limit:
// anything longer would be silently truncated, so it is rejected instead.
const MAX_PASSWORD_BYTES = 72;

// eslint-disable-next-line no-control-regex
const noControlChars = /^[^\u0000-\u001F\u007F]*$/;

// A member signs in with their email address. It is stored in `members.username`,
// lower-cased so it is unique regardless of how it was typed.
const username = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .max(100, 'Email must be at most 100 characters.')
  .pipe(z.email('Enter a valid email address.'));

const fullName = z
  .string({ error: 'Full name is required.' })
  .trim()
  .min(1, 'Full name is required.')
  .max(200, 'Full name must be at most 200 characters.')
  .regex(noControlChars, 'Full name contains invalid characters.');

const password = z
  .string({ error: 'Password is required.' })
  .min(1, 'Password is required.')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_PASSWORD_BYTES, 'Password is too long.');

// 1..2 distinct departments (a member can belong to up to two).
const departmentIds = z
  .array(z.uuid('Select a department.'), { error: 'Select a department.' })
  .min(1, 'Select a department.')
  .max(MAX_MEMBER_DEPARTMENTS, `A member can belong to at most ${MAX_MEMBER_DEPARTMENTS} departments.`)
  .refine((ids) => new Set(ids).size === ids.length, 'Choose each department once.');

const idParams = z.object({ id: z.uuid('Invalid member id.') });

// A department leader's own account fields — used when a department is created with its leader.
export const leaderSchema = z.object({ username, fullName, password });

// `departmentIds` is optional here because an Admin can only ever add members to their own
// department (taken from their session); the super admin must send 1–2 (the service checks).
// Leaders (Admins) are never created here — they come with a department (or "Add leader").
export const createMemberSchema = { body: z.object({ username, fullName, password, departmentIds: departmentIds.optional() }) };

export const updateMemberSchema = {
  params: idParams,
  body: z
    .object({
      fullName: fullName.optional(),
      isActive: z.boolean().optional(),
      password: password.optional(),
      departmentIds: departmentIds.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' }),
};

export const memberIdSchema = { params: idParams };

export type CreateMemberBody = z.infer<typeof createMemberSchema.body>;
export type UpdateMemberParams = z.infer<typeof updateMemberSchema.params>;
export type UpdateMemberBody = z.infer<typeof updateMemberSchema.body>;
export type MemberIdParams = z.infer<typeof idParams>;
