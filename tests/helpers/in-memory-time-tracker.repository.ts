import { randomUUID } from 'node:crypto';
import { Errors } from '../../src/utils/errors';
import type { CreateTrackerInput, TimeTrackerRepository, UpdateTrackerInput } from '../../src/modules/time-tracker/time-tracker.repository';
import type { ActivityHistoryFilters, ActivityHistoryLedgerRecord, LedgerRecord, TrackerRecord } from '../../src/modules/time-tracker/time-tracker.types';

/** Behaves like the Prisma repository, including the (member_id, date) closure uniqueness. */
export class InMemoryTimeTrackerRepository implements TimeTrackerRepository {
  readonly trackers: TrackerRecord[] = [];
  readonly ledger: LedgerRecord[] = [];
  private readonly closedDays = new Set<string>();

  private key(memberId: string, date: string) {
    return `${memberId}|${date}`;
  }

  /** For the member-delete cascade and its impact count. */
  closedDayCount(memberId: string) {
    return [...this.closedDays].filter((k) => k.startsWith(`${memberId}|`)).length;
  }

  removeAllFor(memberId: string) {
    for (let i = this.ledger.length - 1; i >= 0; i--) if (this.ledger[i]!.memberId === memberId) this.ledger.splice(i, 1);
    for (let i = this.trackers.length - 1; i >= 0; i--) if (this.trackers[i]!.memberId === memberId) this.trackers.splice(i, 1);
    for (const k of [...this.closedDays]) if (k.startsWith(`${memberId}|`)) this.closedDays.delete(k);
  }

  async findLastTrackerTime(memberId: string, date: string) {
    const rows = this.trackers.filter((t) => t.memberId === memberId && t.date === date);
    if (rows.length === 0) return null;
    return rows.reduce((latest, t) => (t.trackerTime > latest ? t.trackerTime : latest), rows[0]!.trackerTime);
  }

  async isDayClosed(memberId: string, date: string) {
    return this.closedDays.has(this.key(memberId, date));
  }

  async createWithLedger(input: CreateTrackerInput) {
    const now = new Date();
    const tracker: TrackerRecord = {
      id: randomUUID(),
      memberId: input.memberId,
      date: input.date,
      category: input.category,
      subcategory: input.subcategory,
      comment: input.comment,
      durationMinutes: input.durationMinutes,
      previousTrackerTime: input.previousTrackerTime,
      trackerTime: input.trackerTime,
      gapMinutes: input.gapMinutes,
      taskId: input.taskId,
      createdAt: now,
    };
    this.trackers.push(tracker);
    this.ledger.push({
      id: randomUUID(),
      memberId: input.memberId,
      trackerId: tracker.id,
      date: input.date,
      category: input.category,
      subcategory: input.subcategory,
      durationMinutes: input.durationMinutes,
      entryType: 'TRACKER',
      taskId: null,
      createdAt: now,
    });
    if (input.gapMinutes > 0) {
      this.ledger.push({
        id: randomUUID(),
        memberId: input.memberId,
        trackerId: tracker.id,
        date: input.date,
        category: input.gapCategory,
        subcategory: null,
        durationMinutes: input.gapMinutes,
        entryType: 'GAP',
        taskId: null,
        createdAt: now,
      });
    }
  }

  async findById(id: string) {
    return this.trackers.find((t) => t.id === id) ?? null;
  }

  async findGapCategory(trackerId: string) {
    return this.ledger.find((e) => e.trackerId === trackerId && e.entryType === 'GAP')?.category ?? null;
  }

  async updateWithLedger(id: string, patch: UpdateTrackerInput) {
    const tracker = this.trackers.find((t) => t.id === id);
    if (!tracker) return;
    tracker.category = patch.category;
    tracker.subcategory = patch.subcategory;
    tracker.comment = patch.comment;
    tracker.durationMinutes = patch.durationMinutes;
    tracker.gapMinutes = patch.gapMinutes;
    if (patch.taskId !== undefined) tracker.taskId = patch.taskId;

    const trackerLedger = this.ledger.find((e) => e.trackerId === id && e.entryType === 'TRACKER');
    if (trackerLedger) {
      trackerLedger.category = patch.category;
      trackerLedger.subcategory = patch.subcategory;
      trackerLedger.durationMinutes = patch.durationMinutes;
    }

    const gapIndex = this.ledger.findIndex((e) => e.trackerId === id && e.entryType === 'GAP');
    if (patch.gapMinutes > 0) {
      if (gapIndex >= 0) {
        this.ledger[gapIndex]!.category = patch.gapCategory;
        this.ledger[gapIndex]!.durationMinutes = patch.gapMinutes;
      } else {
        this.ledger.push({
          id: randomUUID(),
          memberId: patch.memberId,
          trackerId: id,
          date: patch.date,
          category: patch.gapCategory,
          subcategory: null,
          durationMinutes: patch.gapMinutes,
          entryType: 'GAP',
          taskId: null,
          createdAt: new Date(),
        });
      }
    } else if (gapIndex >= 0) {
      this.ledger.splice(gapIndex, 1);
    }
  }

  async removeWithLedger(id: string) {
    for (let i = this.ledger.length - 1; i >= 0; i--) if (this.ledger[i]!.trackerId === id) this.ledger.splice(i, 1);
    const trackerIndex = this.trackers.findIndex((t) => t.id === id);
    if (trackerIndex >= 0) this.trackers.splice(trackerIndex, 1);
  }

  /** Like the real join: only a TRACKER row carries its tracker's task. */
  private withTask(e: LedgerRecord): LedgerRecord {
    const taskId = e.entryType === 'TRACKER' && e.trackerId ? (this.trackers.find((t) => t.id === e.trackerId)?.taskId ?? null) : null;
    return { ...e, taskId };
  }

  async listLedgerForDate(memberId: string, date: string) {
    return this.ledger
      .filter((e) => e.memberId === memberId && e.date === date)
      .map((e) => this.withTask(e))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listActivityHistory(filters: ActivityHistoryFilters): Promise<ActivityHistoryLedgerRecord[]> {
    return this.ledger
      .filter(
        (e) =>
          e.date === filters.date &&
          (!filters.memberId || e.memberId === filters.memberId) &&
          (!filters.memberIds || filters.memberIds.includes(e.memberId)) &&
          (!filters.category || e.category === filters.category),
      )
      .map((e) => ({ ...this.withTask(e), comment: e.entryType === 'TRACKER' && e.trackerId ? (this.trackers.find((t) => t.id === e.trackerId)?.comment ?? null) : null }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async closeDay(memberId: string, date: string, remainingMinutes: number) {
    if (this.closedDays.has(this.key(memberId, date))) throw Errors.dayAlreadyClosed();
    if (remainingMinutes > 0) {
      this.ledger.push({
        id: randomUUID(),
        memberId,
        trackerId: null,
        date,
        category: 'BASE',
        subcategory: null,
        durationMinutes: remainingMinutes,
        entryType: 'GAP',
        taskId: null,
        createdAt: new Date(),
      });
    }
    this.closedDays.add(this.key(memberId, date));
  }
}
