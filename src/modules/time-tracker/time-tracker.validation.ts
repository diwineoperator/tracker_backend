import { z } from 'zod';
import { isValidLocalDate } from '../../utils/time';
import { PRIMARY_TRACKER_CATEGORIES, TRACKER_CATEGORIES } from './time-tracker.types';

const MAX_DURATION_MINUTES = 1440; // one day — the real per-request cap is the available window, enforced in the service

const idParams = z.object({ id: z.uuid('Invalid tracker id.') });

const trackerBody = z.object({
  // BASE is gap-only: never chosen as a tracker's own primary category.
  category: z.enum(PRIMARY_TRACKER_CATEGORIES, { error: 'Category is required.' }),
  subcategory: z
    .string()
    .trim()
    .max(100, 'Subcategory must be at most 100 characters.')
    .optional()
    .transform((v) => v || undefined),
  comment: z
    .string()
    .trim()
    .max(500, 'Comment must be at most 500 characters.')
    .optional()
    .transform((v) => v || undefined),
  durationMinutes: z.number('Duration is required.').int().positive('Duration must be greater than zero.').max(MAX_DURATION_MINUTES),
  // What to book any leftover gap time as. Omitted/null = BASE.
  gapCategory: z.enum(TRACKER_CATEGORIES).nullable().optional(),
  // Optional: one of the member's own assigned tasks (ownership is enforced in the service).
  // On an edit, omitted = leave the link alone, null = unlink.
  taskId: z.uuid('Invalid task.').nullable().optional(),
});

export const createTrackerSchema = { body: trackerBody };

/** Same shape as create — editing replaces category/subcategory/comment/duration/gapCategory wholesale. */
export const updateTrackerSchema = { params: idParams, body: trackerBody };

export const trackerIdSchema = { params: idParams };

export const memberIdParamsSchema = { params: z.object({ memberId: z.uuid('Invalid member id.') }) };

export const activityHistoryQuerySchema = {
  query: z.object({
    date: z.string().refine(isValidLocalDate, 'Invalid date.'),
    memberId: z.uuid('Invalid member id.').optional(),
    departmentId: z.uuid('Invalid department id.').optional(),
    // Full category list (including BASE) accepted defensively; the filter UI
    // only ever offers the primary (non-BASE) categories.
    category: z.enum(TRACKER_CATEGORIES).optional(),
  }),
};

/**
 * Member's own history query — deliberately has NO `memberId` field. Zod strips
 * unrecognised keys by default, so even a `?memberId=...` on the URL never
 * reaches the parsed result; the controller sources the member id from the
 * authenticated JWT only (`currentMemberId`), never from client input.
 */
export const memberActivityHistoryQuerySchema = {
  query: z.object({
    date: z.string().refine(isValidLocalDate, 'Invalid date.'),
    category: z.enum(TRACKER_CATEGORIES).optional(),
  }),
};

export type CreateTrackerBody = z.infer<typeof createTrackerSchema.body>;
export type UpdateTrackerParams = z.infer<typeof idParams>;
export type UpdateTrackerBody = z.infer<typeof updateTrackerSchema.body>;
export type TrackerIdParams = z.infer<typeof idParams>;
export type MemberIdParams = z.infer<typeof memberIdParamsSchema.params>;
export type ActivityHistoryQuery = z.infer<typeof activityHistoryQuerySchema.query>;
export type MemberActivityHistoryQuery = z.infer<typeof memberActivityHistoryQuerySchema.query>;
