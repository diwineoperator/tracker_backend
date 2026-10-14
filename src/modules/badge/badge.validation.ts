import { z } from 'zod';

// The moments the member last opened Requests / For You (ISO instants, kept by their browser). Optional: without them,
// every answered request / every open task counts as unread.
const since = z.iso.datetime({ offset: true, error: 'Invalid date.' }).optional();
export const memberBadgesSchema = {
  query: z.object({ requestsSince: since, tasksSince: since }),
};
// A leader's own For You badge follows the same "since I last looked" convention.
export const staffBadgesSchema = { query: z.object({ tasksSince: since }) };

export type MemberBadgesQuery = z.infer<typeof memberBadgesSchema.query>;
export type StaffBadgesQuery = z.infer<typeof staffBadgesSchema.query>;
