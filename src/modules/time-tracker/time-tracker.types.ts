import type { StaffScope } from '../../utils/scope';
/**
 * Domain + API types for the time-tracker module. Deliberately free of Prisma
 * imports so the service layer (and its tests) never depend on the ORM.
 */
export const TRACKER_CATEGORIES = ['WORK', 'SLEEP', 'HEALTH', 'PERSONAL', 'ENTERTAINMENT', 'LEARNING', 'OTHER', 'BASE'] as const;
export type TrackerCategory = (typeof TRACKER_CATEGORIES)[number];

/** BASE is gap-only: never a tracker's own primary category, only a GAP ledger entry's. */
export const PRIMARY_TRACKER_CATEGORIES = TRACKER_CATEGORIES.filter((c) => c !== 'BASE') as Exclude<TrackerCategory, 'BASE'>[];

export type LedgerEntryType = 'TRACKER' | 'GAP';
export type DayStatus = 'OPEN' | 'CLOSED';

/** Who is performing a write — an admin (any entry) or a specific member (their own only). */
/** The admin side always carries its scope: the super admin sees every member, a leader only their department's. */
export type Actor = { role: 'admin'; scope: StaffScope } | { role: 'member'; memberId: string };

/** Persistence-level shape of one submitted tracker row. */
export interface TrackerRecord {
  id: string;
  memberId: string;
  /** Local calendar date (YYYY-MM-DD) this entry belongs to. */
  date: string;
  category: TrackerCategory;
  subcategory: string | null;
  comment: string | null;
  durationMinutes: number;
  previousTrackerTime: Date;
  trackerTime: Date;
  gapMinutes: number;
  /** The assigned task this entry was logged against, if any. Never read by the ledger maths. */
  taskId: string | null;
  createdAt: Date;
}

/** Persistence-level shape of one ledger row (a TRACKER entry, or its paired GAP). */
export interface LedgerRecord {
  id: string;
  memberId: string;
  trackerId: string | null;
  date: string;
  category: TrackerCategory;
  subcategory: string | null;
  durationMinutes: number;
  entryType: LedgerEntryType;
  /** TRACKER rows only: the task their own tracker entry was logged against. GAP rows are always null. */
  taskId: string | null;
  createdAt: Date;
}

/** One ledger row plus the comment the ledger table itself doesn't store (only a
 * TRACKER row has one — copied from the tracker entry it mirrors). */
export interface ActivityHistoryLedgerRecord extends LedgerRecord {
  comment: string | null;
}

export interface ActivityHistoryFilters {
  date: string;
  memberId?: string;
  /** Narrow to these members (a department's roster, resolved by the service). */
  memberIds?: string[];
  category?: TrackerCategory;
}

// ── API response DTOs ────────────────────────────────────────────────────────

/** One tracker's full detail — what an edit form prefills from (the ledger list doesn't carry `comment`). */
export interface TrackerDto {
  id: string;
  category: TrackerCategory;
  subcategory: string | null;
  comment: string | null;
  durationMinutes: number;
  taskId: string | null;
  /** The category booked for this tracker's leftover time, from its paired GAP
   * ledger row — null if gapMinutes was 0 (no GAP row exists at all). */
  gapCategory: TrackerCategory | null;
}

export interface LedgerEntryDto {
  id: string;
  trackerId: string | null;
  category: TrackerCategory;
  subcategory: string | null;
  durationMinutes: number;
  entryType: LedgerEntryType;
  /** TRACKER rows only — GAP rows are always null. */
  taskId: string | null;
  taskTitle: string | null;
  /** ISO-8601 UTC instant. */
  createdAt: string;
}

/** Everything the dashboard needs for one local day, in one response. */
export interface TodaySummaryDto {
  date: string;
  timezone: string;
  serverTime: string;
  /** Chronological — this is what the dashboard's flat entry list renders from. */
  entries: LedgerEntryDto[];
  /** Minutes per category, zero-filled for every category (including BASE). */
  totals: Record<TrackerCategory, number>;
  usedMinutes: number;
  remainingMinutes: number;
  /** ISO-8601 UTC instant of the day's last tracker, or null if none yet. */
  lastTrackerTime: string | null;
  status: DayStatus;
}

/** Admin view: one member's today, with enough of who they are to display it. */
export interface MemberTodaySummaryDto extends TodaySummaryDto {
  memberId: string;
  memberName: string;
  memberUsername: string;
  /** The departments the member belongs to (1..2). */
  departmentIds: string[];
}

/** Admin: one historical ledger row (Activity History), enriched with who it
 * belongs to and, for a TRACKER row, its comment. */
export interface ActivityHistoryEntryDto {
  id: string;
  date: string;
  memberId: string;
  memberName: string;
  memberUsername: string;
  category: TrackerCategory;
  subcategory: string | null;
  comment: string | null;
  taskTitle: string | null;
  durationMinutes: number;
  entryType: LedgerEntryType;
  /** The tracker a TRACKER row or its own GAP row came from — lets a client show them as one entry. Null for the day-closing leftover. */
  trackerId: string | null;
  /** ISO-8601 UTC instant. */
  createdAt: string;
}

export interface ActivityHistorySummaryDto {
  /** Distinct members with any activity in this (filtered) result set. */
  memberCount: number;
  /** Sum of TRACKER-entry durations only — explicitly logged time, not GAP/BASE. */
  trackedMinutes: number;
  entryCount: number;
}

/** Admin: read-only cross-member ledger report for one local day, optionally
 * narrowed to one member and/or category. */
export interface ActivityHistoryResponseDto {
  date: string;
  entries: ActivityHistoryEntryDto[];
  summary: ActivityHistorySummaryDto;
  /** Present only when filtered to one member: that member's full-day totals
   * for the selected date (same shape/calculation as `today()`). */
  memberSummary: MemberTodaySummaryDto | null;
}
