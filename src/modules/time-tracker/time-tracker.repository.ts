import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../../config/database';
import { Errors } from '../../utils/errors';
import type { ActivityHistoryFilters, ActivityHistoryLedgerRecord, LedgerRecord, TrackerCategory, TrackerRecord } from './time-tracker.types';

export interface CreateTrackerInput {
  memberId: string;
  date: string;
  category: TrackerCategory;
  subcategory: string | null;
  comment: string | null;
  durationMinutes: number;
  previousTrackerTime: Date;
  trackerTime: Date;
  gapMinutes: number;
  /** Only meaningful when gapMinutes > 0. */
  gapCategory: TrackerCategory;
  /** Optional link to the assigned task this time was logged against. */
  taskId: string | null;
}

export interface UpdateTrackerInput {
  memberId: string;
  date: string;
  category: TrackerCategory;
  subcategory: string | null;
  comment: string | null;
  durationMinutes: number;
  gapMinutes: number;
  /** Only meaningful when gapMinutes > 0. */
  gapCategory: TrackerCategory;
  /** Undefined = leave the link as it is; null = unlink; an id = link to that task. */
  taskId?: string | null;
}

/**
 * Data-access contract. Everything above this line (service, tests) depends on
 * the interface; only PrismaTimeTrackerRepository knows about Prisma/SQL.
 */
export interface TimeTrackerRepository {
  /** The local day's most recent tracker's server-clock time, or null if none yet. */
  findLastTrackerTime(memberId: string, date: string): Promise<Date | null>;
  isDayClosed(memberId: string, date: string): Promise<boolean>;
  /**
   * Creates the tracker row, its TRACKER ledger row, and — only if gapMinutes > 0 —
   * a second GAP ledger row, all in one transaction (tracked + gap must always
   * tally with the window that was checked, never partially saved).
   */
  createWithLedger(input: CreateTrackerInput): Promise<void>;
  findById(id: string): Promise<TrackerRecord | null>;
  /** The category of this tracker's paired GAP ledger row (what its leftover
   * time was booked as), or null if gapMinutes was 0 and no GAP row exists. */
  findGapCategory(trackerId: string): Promise<TrackerCategory | null>;
  /**
   * Replaces category/subcategory/comment/duration on the tracker row and its
   * TRACKER ledger row, then reconciles the paired GAP row (update/create/delete
   * as needed) against the NEW gapMinutes — all in one transaction. Never touches
   * `previousTrackerTime`/`trackerTime` (the window is a fixed historical fact) or
   * any other entry: each tracker's own tracked+gap reconciles independently.
   */
  updateWithLedger(id: string, patch: UpdateTrackerInput): Promise<void>;
  /** Deletes the tracker row and both its ledger rows (TRACKER + GAP if any), atomically. */
  removeWithLedger(id: string): Promise<void>;
  /** All of a local day's ledger rows, chronological. */
  listLedgerForDate(memberId: string, date: string): Promise<LedgerRecord[]>;
  /**
   * Admin: every ledger row for one local day across every member, optionally
   * narrowed to one member and/or category, chronological. Read-only — this
   * never touches `today()`'s own query path.
   */
  listActivityHistory(filters: ActivityHistoryFilters): Promise<ActivityHistoryLedgerRecord[]>;
  /**
   * Books whatever is left of the day (`remainingMinutes`) as one more GAP/BASE
   * ledger row (only if > 0, not tied to any tracker) and marks the day closed,
   * atomically. Throws `DAY_ALREADY_CLOSED` if it already was (the unique index
   * on (member_id, date) is the actual guard against a concurrent double-close).
   */
  closeDay(memberId: string, date: string, remainingMinutes: number): Promise<void>;
}

const toTrackerRecord = (r: {
  id: string;
  memberId: string;
  date: Date;
  category: string;
  subcategory: string | null;
  comment: string | null;
  durationMinutes: number;
  previousTrackerTime: Date;
  trackerTime: Date;
  gapMinutes: number;
  taskId: string | null;
  createdAt: Date;
}): TrackerRecord => ({
  id: r.id,
  memberId: r.memberId,
  date: r.date.toISOString().slice(0, 10),
  category: r.category as TrackerCategory,
  subcategory: r.subcategory,
  comment: r.comment,
  durationMinutes: r.durationMinutes,
  previousTrackerTime: r.previousTrackerTime,
  trackerTime: r.trackerTime,
  gapMinutes: r.gapMinutes,
  taskId: r.taskId,
  createdAt: r.createdAt,
});

const toLedgerRecord = (r: {
  id: string;
  memberId: string;
  trackerId: string | null;
  date: Date;
  category: string;
  subcategory: string | null;
  durationMinutes: number;
  entryType: string;
  createdAt: Date;
  tracker?: { taskId: string | null } | null;
}): LedgerRecord => ({
  id: r.id,
  memberId: r.memberId,
  trackerId: r.trackerId,
  date: r.date.toISOString().slice(0, 10),
  category: r.category as TrackerCategory,
  subcategory: r.subcategory,
  durationMinutes: r.durationMinutes,
  entryType: r.entryType as LedgerRecord['entryType'],
  // Only a TRACKER row carries its tracker's task; the paired GAP row shares the trackerId but not the task.
  taskId: r.entryType === 'TRACKER' ? (r.tracker?.taskId ?? null) : null,
  createdAt: r.createdAt,
});

export class PrismaTimeTrackerRepository implements TimeTrackerRepository {
  constructor(private readonly db: Database) {}

  async findLastTrackerTime(memberId: string, date: string) {
    const row = await this.db.timeTrackerEntry.findFirst({
      where: { memberId, date: new Date(date) },
      orderBy: { trackerTime: 'desc' },
      select: { trackerTime: true },
    });
    return row?.trackerTime ?? null;
  }

  async isDayClosed(memberId: string, date: string) {
    const row = await this.db.dailyClosure.findUnique({
      where: { memberId_date: { memberId, date: new Date(date) } },
    });
    return row !== null;
  }

  async createWithLedger(input: CreateTrackerInput) {
    await this.db.$transaction(async (tx) => {
      const tracker = await tx.timeTrackerEntry.create({
        data: {
          memberId: input.memberId,
          date: new Date(input.date),
          category: input.category,
          subcategory: input.subcategory,
          comment: input.comment,
          durationMinutes: input.durationMinutes,
          previousTrackerTime: input.previousTrackerTime,
          trackerTime: input.trackerTime,
          gapMinutes: input.gapMinutes,
          taskId: input.taskId,
        },
      });
      await tx.timeLedgerEntry.create({
        data: {
          memberId: input.memberId,
          trackerId: tracker.id,
          date: new Date(input.date),
          category: input.category,
          subcategory: input.subcategory,
          durationMinutes: input.durationMinutes,
          entryType: 'TRACKER',
        },
      });
      if (input.gapMinutes > 0) {
        await tx.timeLedgerEntry.create({
          data: {
            memberId: input.memberId,
            trackerId: tracker.id,
            date: new Date(input.date),
            category: input.gapCategory,
            durationMinutes: input.gapMinutes,
            entryType: 'GAP',
          },
        });
      }
    });
  }

  async findById(id: string) {
    const row = await this.db.timeTrackerEntry.findUnique({ where: { id } });
    return row ? toTrackerRecord(row) : null;
  }

  async findGapCategory(trackerId: string) {
    const row = await this.db.timeLedgerEntry.findFirst({ where: { trackerId, entryType: 'GAP' }, select: { category: true } });
    return (row?.category as TrackerCategory | undefined) ?? null;
  }

  async updateWithLedger(id: string, patch: UpdateTrackerInput) {
    await this.db.$transaction(async (tx) => {
      await tx.timeTrackerEntry.update({
        where: { id },
        data: {
          category: patch.category,
          subcategory: patch.subcategory,
          comment: patch.comment,
          durationMinutes: patch.durationMinutes,
          gapMinutes: patch.gapMinutes,
          ...(patch.taskId !== undefined && { taskId: patch.taskId }),
        },
      });
      await tx.timeLedgerEntry.updateMany({
        where: { trackerId: id, entryType: 'TRACKER' },
        data: { category: patch.category, subcategory: patch.subcategory, durationMinutes: patch.durationMinutes },
      });

      const existingGap = await tx.timeLedgerEntry.findFirst({ where: { trackerId: id, entryType: 'GAP' } });
      if (patch.gapMinutes > 0) {
        if (existingGap) {
          await tx.timeLedgerEntry.update({ where: { id: existingGap.id }, data: { category: patch.gapCategory, durationMinutes: patch.gapMinutes } });
        } else {
          await tx.timeLedgerEntry.create({
            data: {
              memberId: patch.memberId,
              trackerId: id,
              date: new Date(patch.date),
              category: patch.gapCategory,
              durationMinutes: patch.gapMinutes,
              entryType: 'GAP',
            },
          });
        }
      } else if (existingGap) {
        await tx.timeLedgerEntry.delete({ where: { id: existingGap.id } });
      }
    });
  }

  async removeWithLedger(id: string) {
    await this.db.$transaction(async (tx) => {
      await tx.timeLedgerEntry.deleteMany({ where: { trackerId: id } });
      await tx.timeTrackerEntry.delete({ where: { id } });
    });
  }

  async listLedgerForDate(memberId: string, date: string) {
    const rows = await this.db.timeLedgerEntry.findMany({
      where: { memberId, date: new Date(date) },
      include: { tracker: { select: { taskId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toLedgerRecord);
  }

  async listActivityHistory(filters: ActivityHistoryFilters): Promise<ActivityHistoryLedgerRecord[]> {
    const rows = await this.db.timeLedgerEntry.findMany({
      where: {
        date: new Date(filters.date),
        // Both may be present (a department's roster AND one member); AND keeps them from overwriting each other.
        AND: [
          ...(filters.memberId ? [{ memberId: filters.memberId }] : []),
          ...(filters.memberIds ? [{ memberId: { in: filters.memberIds } }] : []),
        ],
        ...(filters.category ? { category: filters.category } : {}),
      },
      include: { tracker: { select: { comment: true, taskId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // A paired GAP row shares its TRACKER row's trackerId — the comment belongs
    // to what the member actually wrote about, not the leftover remainder.
    return rows.map((r) => ({ ...toLedgerRecord(r), comment: r.entryType === 'TRACKER' ? (r.tracker?.comment ?? null) : null }));
  }

  async closeDay(memberId: string, date: string, remainingMinutes: number) {
    try {
      await this.db.$transaction(async (tx) => {
        if (remainingMinutes > 0) {
          await tx.timeLedgerEntry.create({
            data: {
              memberId,
              trackerId: null,
              date: new Date(date),
              category: 'BASE',
              durationMinutes: remainingMinutes,
              entryType: 'GAP',
            },
          });
        }
        // Last statement: if a concurrent close already ran, this is what fails
        // (the unique index on member_id+date), and nothing above gets committed.
        await tx.dailyClosure.create({ data: { memberId, date: new Date(date) } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.dayAlreadyClosed();
      }
      throw err;
    }
  }
}
