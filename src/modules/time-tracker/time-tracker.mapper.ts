import type { ActivityHistoryEntryDto, ActivityHistoryLedgerRecord, LedgerEntryDto, LedgerRecord, TrackerCategory, TrackerDto, TrackerRecord } from './time-tracker.types';

/** `gapCategory` isn't a column on the tracker row itself — it lives on the
 * paired GAP ledger row, so the service looks it up separately and passes it in. */
export function toTrackerDto(record: TrackerRecord, gapCategory: TrackerCategory | null): TrackerDto {
  return {
    id: record.id,
    category: record.category,
    subcategory: record.subcategory,
    comment: record.comment,
    durationMinutes: record.durationMinutes,
    taskId: record.taskId,
    gapCategory,
  };
}

/** Database record → API DTO. The only place record fields cross the API boundary. */
export function toLedgerEntryDto(record: LedgerRecord, taskTitles: ReadonlyMap<string, string> = new Map()): LedgerEntryDto {
  return {
    id: record.id,
    trackerId: record.trackerId,
    category: record.category,
    subcategory: record.subcategory,
    durationMinutes: record.durationMinutes,
    entryType: record.entryType,
    taskId: record.taskId,
    taskTitle: record.taskId ? (taskTitles.get(record.taskId) ?? null) : null,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Member identity isn't known to the repository layer (that's `MemberRepository`'s
 * job) — the service passes it in after looking it up. */
export function toActivityHistoryEntryDto(
  record: ActivityHistoryLedgerRecord,
  memberName: string,
  memberUsername: string,
  taskTitle: string | null,
): ActivityHistoryEntryDto {
  return {
    id: record.id,
    date: record.date,
    memberId: record.memberId,
    memberName,
    memberUsername,
    category: record.category,
    subcategory: record.subcategory,
    comment: record.comment,
    taskTitle,
    durationMinutes: record.durationMinutes,
    entryType: record.entryType,
    trackerId: record.trackerId,
    createdAt: record.createdAt.toISOString(),
  };
}
