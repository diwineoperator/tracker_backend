import type { Clock } from '../../utils/clock';
import type { MemberRepository } from '../member/member.repository';
import type { TaskRepository } from '../task/task.repository';
import { Errors } from '../../utils/errors';
import { inScope, type StaffScope } from '../../utils/scope';
import { localDayRangeToUtc, toLocalDate } from '../../utils/time';
import { toActivityHistoryEntryDto, toLedgerEntryDto, toTrackerDto } from './time-tracker.mapper';
import type { TimeTrackerRepository } from './time-tracker.repository';
import {
  TRACKER_CATEGORIES,
  type ActivityHistoryResponseDto,
  type Actor,
  type MemberTodaySummaryDto,
  type TodaySummaryDto,
  type TrackerCategory,
  type TrackerDto,
} from './time-tracker.types';
import type { ActivityHistoryQuery, CreateTrackerBody, UpdateTrackerBody } from './time-tracker.validation';

const MINUTES_PER_DAY = 1440;

/**
 * All business rules for the daily time ledger live here:
 *  - the server clock is authoritative for "now" and for which local day an
 *    entry belongs to (DLD §12/§14)
 *  - a tracker's window is [previous tracker's time (or local midnight, for the
 *    day's first entry), now] — whatever the duration doesn't cover becomes a
 *    GAP ledger row (the chosen gapCategory, or BASE)
 *  - a day, once closed, accepts no more trackers; closing books whatever is
 *    left of the day's 1440 minutes as BASE
 *  - "total tracked never exceeds 1440" is not a separate check: it falls out
 *    of the per-entry window check, since every entry's window is itself
 *    bounded by elapsed time since local midnight
 */
export class TimeTrackerService {
  constructor(
    private readonly repo: TimeTrackerRepository,
    private readonly members: Pick<MemberRepository, 'list' | 'findById'>,
    private readonly tasks: Pick<TaskRepository, 'findById' | 'findManyByIds' | 'update'>,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  async create(memberId: string, input: CreateTrackerBody): Promise<TodaySummaryDto> {
    const now = this.clock.now();
    const date = toLocalDate(now, this.timezone);

    if (await this.repo.isDayClosed(memberId, date)) throw Errors.dayClosed();
    const linkedTask = input.taskId ? await this.requireLinkableTask(memberId, input.taskId) : null;

    const previousTrackerTime = (await this.repo.findLastTrackerTime(memberId, date)) ?? localDayRangeToUtc(date, date, this.timezone).start;
    // Nearest whole minute (0-29s down, 30-59s up), not truncation — timestamps
    // themselves are untouched, only this derived minute value rounds.
    const windowMinutes = Math.round((now.getTime() - previousTrackerTime.getTime()) / 60_000);
    if (input.durationMinutes > windowMinutes) throw Errors.durationExceedsAvailable(windowMinutes);

    const gapMinutes = windowMinutes - input.durationMinutes;
    await this.repo.createWithLedger({
      memberId,
      date,
      category: input.category,
      subcategory: input.subcategory ?? null,
      comment: input.comment ?? null,
      durationMinutes: input.durationMinutes,
      previousTrackerTime,
      trackerTime: now,
      gapMinutes,
      gapCategory: input.gapCategory ?? 'BASE',
      taskId: input.taskId ?? null,
    });
    await this.afterLoggedAgainst(linkedTask);

    return this.today(memberId);
  }

  async today(memberId: string): Promise<TodaySummaryDto> {
    const now = this.clock.now();
    return this.summaryForDate(memberId, toLocalDate(now, this.timezone), now);
  }

  /**
   * One member's full ledger summary for a given local day — the exact
   * calculation `today()` uses, just not hardcoded to "now". `today()` calls
   * this with today's own date; the admin Activity History drill-down
   * (`summaryForMemberDate`) calls it with an arbitrary past date. `now` is
   * threaded through (rather than re-read here) so a single `today()` call
   * still reads the clock exactly once, as before this was extracted.
   */
  private async summaryForDate(memberId: string, date: string, now: Date): Promise<TodaySummaryDto> {
    const [entries, closed, lastTrackerTime] = await Promise.all([
      this.repo.listLedgerForDate(memberId, date),
      this.repo.isDayClosed(memberId, date),
      this.repo.findLastTrackerTime(memberId, date),
    ]);

    const totals = Object.fromEntries(TRACKER_CATEGORIES.map((c) => [c, 0])) as Record<TrackerCategory, number>;
    for (const e of entries) totals[e.category] += e.durationMinutes;
    const usedMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    // Display-only: which task each tracker row was logged against. Nothing above reads it.
    const taskTitles = await this.taskTitles(entries.map((e) => e.taskId));

    return {
      date,
      timezone: this.timezone,
      serverTime: now.toISOString(),
      entries: entries.map((e) => toLedgerEntryDto(e, taskTitles)),
      totals,
      usedMinutes,
      remainingMinutes: Math.max(0, MINUTES_PER_DAY - usedMinutes),
      lastTrackerTime: lastTrackerTime?.toISOString() ?? null,
      status: closed ? 'CLOSED' : 'OPEN',
    };
  }

  /** Admin: one member's full daily summary for an arbitrary past local date
   * (Activity History's per-member drill-down). Same calculation as `today()`. */
  async summaryForMemberDate(memberId: string, date: string): Promise<MemberTodaySummaryDto> {
    const member = await this.members.findById(memberId);
    if (!member) throw Errors.memberNotFound();
    return this.withMember(member, this.summaryForDate(memberId, date, this.clock.now()));
  }

  /**
   * Admin: read-only cross-member ledger report for one local day, optionally
   * narrowed to a member and/or category. Purely a report over existing
   * time_tracker/time_ledger rows — never touches today's tracker flow.
   */
  async activityHistory(scope: StaffScope, query: ActivityHistoryQuery): Promise<ActivityHistoryResponseDto> {
    // A leader's report is always limited to their own department, whatever ?departmentId=… says.
    const filters = { ...query, ...(scope.kind === 'department' && { departmentId: scope.departmentId }) };
    const members = await this.members.list();
    const memberById = new Map(members.map((m) => [m.id, m]));

    // A department filter is resolved to that department's roster here (members
    // are the member repository's business), then applied at the database level
    // like every other filter. Combined with a member filter, both must hold.
    let rosterIds: string[] | undefined;
    if (filters.departmentId) {
      const inDepartment = members.filter((m) => m.role === 'MEMBER' && m.departmentIds.includes(filters.departmentId!)).map((m) => m.id);
      // A leader's own directly-assigned tasks can carry logged time too (self-service, same as a
      // member's) — their report includes it, alongside their department's members.
      const roster = scope.kind === 'department' ? [...inDepartment, scope.adminId] : inDepartment;
      rosterIds = filters.memberId ? roster.filter((id) => id === filters.memberId) : roster;
    }
    const nobodyMatches = rosterIds !== undefined && rosterIds.length === 0;

    const records = nobodyMatches
      ? []
      : await this.repo.listActivityHistory({
          date: filters.date,
          ...(filters.memberId && { memberId: filters.memberId }),
          ...(rosterIds && { memberIds: rosterIds }),
          ...(filters.category && { category: filters.category }),
        });
    const taskTitles = await this.taskTitles(records.map((r) => r.taskId));

    const entries = records.map((r) => {
      const member = memberById.get(r.memberId);
      return toActivityHistoryEntryDto(r, member?.fullName ?? 'Unknown member', member?.username ?? '', r.taskId ? (taskTitles.get(r.taskId) ?? null) : null);
    });

    const memberIds = new Set(entries.map((e) => e.memberId));
    const trackedMinutes = entries.filter((e) => e.entryType === 'TRACKER').reduce((sum, e) => sum + e.durationMinutes, 0);
    const memberSummary = filters.memberId && !nobodyMatches ? await this.summaryForMemberDate(filters.memberId, filters.date) : null;

    return {
      date: filters.date,
      entries,
      summary: { memberCount: memberIds.size, trackedMinutes, entryCount: entries.length },
      memberSummary,
    };
  }

  async closeDay(memberId: string): Promise<TodaySummaryDto> {
    const now = this.clock.now();
    const date = toLocalDate(now, this.timezone);
    if (await this.repo.isDayClosed(memberId, date)) throw Errors.dayAlreadyClosed();

    const entries = await this.repo.listLedgerForDate(memberId, date);
    const usedMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    await this.repo.closeDay(memberId, date, Math.max(0, MINUTES_PER_DAY - usedMinutes));

    return this.today(memberId);
  }

  /**
   * One tracker's full detail (including `comment` and `gapCategory`, neither of
   * which the ledger/today list carries) — what an edit form prefills from.
   * `gapCategory` lives on the paired GAP ledger row, not the tracker row
   * itself, so it's a separate lookup. Same visibility rule as `update`/`remove`.
   */
  async get(actor: Actor, id: string): Promise<TrackerDto> {
    const tracker = await this.requireVisible(actor, id);
    const gapCategory = await this.repo.findGapCategory(id);
    return toTrackerDto(tracker, gapCategory);
  }

  /**
   * Edits an entry's category/subcategory/comment/duration. The window
   * (`trackerTime - previousTrackerTime`) is a fixed historical fact — never
   * recomputed here — so only this entry's own gap (and its paired GAP ledger
   * row) needs reconciling; no other entry is ever touched. Admin: any entry.
   * Member: only their own, reported as not-found otherwise (never confirms
   * someone else's entry exists). Blocked once that entry's day is closed.
   */
  async update(actor: Actor, id: string, input: UpdateTrackerBody): Promise<TodaySummaryDto> {
    const tracker = await this.requireVisible(actor, id, true);
    if (await this.repo.isDayClosed(tracker.memberId, tracker.date)) throw Errors.dayClosed();

    // Same nearest-whole-minute rounding as create() — the stored timestamps are
    // the fixed historical fact; only this derived minute value rounds.
    const windowMinutes = Math.round((tracker.trackerTime.getTime() - tracker.previousTrackerTime.getTime()) / 60_000);
    if (input.durationMinutes > windowMinutes) throw Errors.durationExceedsAvailable(windowMinutes);
    const gapMinutes = windowMinutes - input.durationMinutes;

    // Omitted taskId leaves the link alone (an admin editing someone's entry never
    // sees their task list); null unlinks; a NEW task must be the entry owner's own
    // and still open. Keeping the task it already has is always fine.
    const newlyLinked = input.taskId && input.taskId !== tracker.taskId ? await this.requireLinkableTask(tracker.memberId, input.taskId) : null;

    await this.repo.updateWithLedger(id, {
      memberId: tracker.memberId,
      date: tracker.date,
      category: input.category,
      subcategory: input.subcategory ?? null,
      comment: input.comment ?? null,
      durationMinutes: input.durationMinutes,
      gapMinutes,
      gapCategory: input.gapCategory ?? 'BASE',
      ...(input.taskId !== undefined && { taskId: input.taskId }),
    });
    await this.afterLoggedAgainst(newlyLinked);

    return this.today(tracker.memberId);
  }

  /** Same visibility/day-closed rules as `update`. Removes the entry and its ledger rows. */
  async remove(actor: Actor, id: string): Promise<TodaySummaryDto> {
    const tracker = await this.requireVisible(actor, id, true);
    if (await this.repo.isDayClosed(tracker.memberId, tracker.date)) throw Errors.dayClosed();

    await this.repo.removeWithLedger(id);
    return this.today(tracker.memberId);
  }

  /** Admin: every member's today, for the overview dashboard. Today-only — no history/date range. */
  async overview(scope: StaffScope): Promise<MemberTodaySummaryDto[]> {
    const members = (await this.members.list()).filter((m) => m.role === 'MEMBER' && inScope(scope, m.departmentIds));
    return Promise.all(members.map((m) => this.withMember(m, this.today(m.id))));
  }

  /** Admin: one member's today, for the drill-down detail view. */
  async todayForMember(scope: StaffScope, memberId: string): Promise<MemberTodaySummaryDto> {
    const member = await this.members.findById(memberId);
    if (!member || member.role !== 'MEMBER' || !inScope(scope, member.departmentIds)) throw Errors.memberNotFound();
    return this.withMember(member, this.today(memberId));
  }

  private async withMember(
    member: { id: string; fullName: string; username: string; departmentIds: string[] },
    today: Promise<TodaySummaryDto>,
  ): Promise<MemberTodaySummaryDto> {
    return {
      ...(await today),
      memberId: member.id,
      memberName: member.fullName,
      memberUsername: member.username,
      departmentIds: member.departmentIds,
    };
  }

  /**
   * A task an entry may be logged against: the member's OWN, and not yet done.
   * Someone else's task is reported as not-found, exactly like someone else's
   * tracker entry — a member can never probe another member's task ids.
   */
  private async requireLinkableTask(memberId: string, taskId: string) {
    const task = await this.tasks.findById(taskId);
    if (!task || task.memberId !== memberId) throw Errors.taskNotFound();
    if (task.status === 'DONE') throw Errors.taskClosed();
    return task;
  }

  /**
   * After time was logged against a task: a To-do task moves to In progress (work has begun; no
   * other status is touched), and the member's running stopwatch on it, if any, ends — its
   * elapsed time was what they just saved. Only the task's own columns change; the ledger
   * maths above never sees either.
   */
  private async afterLoggedAgainst(task: { id: string; status: string; timerStartedAt: Date | null } | null): Promise<void> {
    if (!task) return;
    const patch = { ...(task.status === 'TODO' && { status: 'IN_PROGRESS' as const }), ...(task.timerStartedAt && { timerStartedAt: null }) };
    if (Object.keys(patch).length > 0) await this.tasks.update(task.id, patch);
  }

  /** Display-only title lookup for the tasks some entries were logged against (one query, only if any). */
  private async taskTitles(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    return new Map((await this.tasks.findManyByIds(unique)).map((t) => [t.id, t.title]));
  }

  /**
   * Someone else's entry is reported as not-found — never confirms it exists. The super admin sees
   * everything; a leader, the entries of their department's members. A leader may READ a member who
   * also belongs to another department, but not CHANGE their entries (`write`): those can carry work
   * for the other department, so only the super admin edits them.
   */
  private async requireVisible(actor: Actor, id: string, write = false) {
    const tracker = await this.repo.findById(id);
    if (!tracker) throw Errors.trackerNotFound();
    if (actor.role === 'member' && tracker.memberId !== actor.memberId) throw Errors.trackerNotFound();
    if (actor.role === 'admin' && actor.scope.kind === 'department') {
      const owner = await this.members.findById(tracker.memberId);
      if (!owner || !inScope(actor.scope, owner.departmentIds)) throw Errors.trackerNotFound();
      if (write && owner.departmentIds.length > 1) throw Errors.memberShared();
    }
    return tracker;
  }
}
