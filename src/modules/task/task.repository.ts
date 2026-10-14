import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../../config/database';
import { Errors } from '../../utils/errors';
import type { TaskFilter, TaskRecord, TaskStatus } from './task.types';

export interface CreateTaskInput {
  title: string;
  description: string | null;
  departmentId: string;
  memberId: string;
  status: TaskStatus;
  dueDate: string | null;
  createdBy: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  departmentId?: string;
  memberId?: string;
  status?: TaskStatus;
  dueDate?: string | null;
  timerStartedAt?: Date | null;
  /** Set when the task is handed to a different member. */
  assignedAt?: Date;
}

export interface TaskRepository {
  /** Newest first. Filters combine (AND); an empty filter returns every task. */
  list(filter: TaskFilter): Promise<TaskRecord[]>;
  findById(id: string): Promise<TaskRecord | null>;
  findManyByIds(ids: string[]): Promise<TaskRecord[]>;
  create(input: CreateTaskInput): Promise<TaskRecord>;
  update(id: string, patch: UpdateTaskInput): Promise<TaskRecord | null>;
  /**
   * Returns false if it does not exist. Time entries logged against it are KEPT and simply
   * unlinked (their task becomes empty) — deleting a task never changes anyone's time.
   */
  remove(id: string): Promise<boolean>;
  /** Total tracker-entry minutes per task id (tasks with none are simply absent). */
  loggedMinutes(ids: string[]): Promise<Map<string, number>>;
}

const toRecord = (r: {
  id: string;
  title: string;
  description: string | null;
  departmentId: string;
  memberId: string;
  status: string;
  dueDate: Date | null;
  completedAt: Date | null;
  timerStartedAt: Date | null;
  createdBy: string;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): TaskRecord => ({
  id: r.id,
  title: r.title,
  description: r.description,
  departmentId: r.departmentId,
  memberId: r.memberId,
  status: r.status as TaskStatus,
  dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
  completedAt: r.completedAt,
  timerStartedAt: r.timerStartedAt,
  createdBy: r.createdBy,
  assignedAt: r.assignedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toDate = (v: string | null) => (v ? new Date(v) : null);

export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}

  async list(filter: TaskFilter) {
    const rows = await this.db.task.findMany({
      where: {
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        ...(filter.memberId ? { memberId: filter.memberId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.createdBy ? { createdBy: filter.createdBy } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async findById(id: string) {
    const row = await this.db.task.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return (await this.db.task.findMany({ where: { id: { in: ids } } })).map(toRecord);
  }

  async create(input: CreateTaskInput) {
    return toRecord(
      await this.db.task.create({ data: { ...input, dueDate: toDate(input.dueDate), completedAt: input.status === 'DONE' ? new Date() : null } }),
    );
  }

  async update(id: string, patch: UpdateTaskInput) {
    try {
      const { dueDate, ...rest } = patch;
      // completed_at follows the status: stamped on the move INTO Done (kept if it was
      // already Done), cleared on the move out.
      let completedAt: Date | null | undefined;
      if (patch.status !== undefined) {
        const current = await this.db.task.findUnique({ where: { id }, select: { status: true, completedAt: true } });
        if (!current) return null;
        completedAt = patch.status === 'DONE' ? (current.status === 'DONE' ? current.completedAt : new Date()) : null;
      }
      // A finished task has no running stopwatch.
      const timerStartedAt = patch.status === 'DONE' ? null : patch.timerStartedAt;
      return toRecord(
        await this.db.task.update({
          where: { id },
          data: { ...rest, ...(dueDate !== undefined && { dueDate: toDate(dueDate) }), ...(completedAt !== undefined && { completedAt }), ...(timerStartedAt !== undefined && { timerStartedAt }) },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2025') return null;
        if (err.code === 'P2002') throw Errors.timerAlreadyRunning(); // the one-running-timer-per-member index
      }
      throw err;
    }
  }

  async loggedMinutes(ids: string[]) {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await this.db.timeTrackerEntry.groupBy({ by: ['taskId'], where: { taskId: { in: ids } }, _sum: { durationMinutes: true } });
    return new Map(rows.flatMap((r) => (r.taskId ? [[r.taskId, r._sum.durationMinutes ?? 0] as [string, number]] : [])));
  }

  async remove(id: string) {
    try {
      // One transaction: entries logged against the task keep every minute (duration, gap, ledger
      // rows are untouched) and only lose their link to it, then the task itself goes.
      await this.db.$transaction([this.db.timeTrackerEntry.updateMany({ where: { taskId: id }, data: { taskId: null } }), this.db.task.delete({ where: { id } })]);
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
      throw err;
    }
  }
}
