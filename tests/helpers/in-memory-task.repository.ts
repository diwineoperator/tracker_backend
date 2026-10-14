import { randomUUID } from 'node:crypto';
import { Errors } from '../../src/utils/errors';
import type { CreateTaskInput, TaskRepository, UpdateTaskInput } from '../../src/modules/task/task.repository';
import type { TaskFilter, TaskRecord } from '../../src/modules/task/task.types';
import type { TrackerRecord } from '../../src/modules/time-tracker/time-tracker.types';

/** Behaves like the Prisma repository (newest first, AND-combined filters). */
export class InMemoryTaskRepository implements TaskRepository {
  readonly rows: TaskRecord[] = [];
  /** The tracker entries to total logged minutes from (the same rows the tracker repository holds). */
  constructor(private readonly trackerRows: () => TrackerRecord[] = () => []) {}

  async loggedMinutes(ids: string[]) {
    const totals = new Map<string, number>();
    for (const t of this.trackerRows()) {
      if (t.taskId && ids.includes(t.taskId)) totals.set(t.taskId, (totals.get(t.taskId) ?? 0) + t.durationMinutes);
    }
    return totals;
  }

  async list(filter: TaskFilter) {
    return this.rows
      .filter(
        (t) =>
          (!filter.departmentId || t.departmentId === filter.departmentId) &&
          (!filter.memberId || t.memberId === filter.memberId) &&
          (!filter.status || t.status === filter.status) &&
          (!filter.createdBy || t.createdBy === filter.createdBy),
      )
      .map((t) => ({ ...t }))
      .reverse();
  }

  async findById(id: string) {
    const row = this.rows.find((t) => t.id === id);
    return row ? { ...row } : null;
  }

  async findManyByIds(ids: string[]) {
    return this.rows.filter((t) => ids.includes(t.id)).map((t) => ({ ...t }));
  }

  async create(input: CreateTaskInput) {
    const now = new Date();
    const row: TaskRecord = { id: randomUUID(), ...input, completedAt: input.status === 'DONE' ? now : null, timerStartedAt: null, assignedAt: now, createdAt: now, updatedAt: now };
    this.rows.push(row);
    return { ...row };
  }

  async update(id: string, patch: UpdateTaskInput) {
    const row = this.rows.find((t) => t.id === id);
    if (!row) return null;
    const now = new Date();
    if (patch.status !== undefined) row.completedAt = patch.status === 'DONE' ? (row.status === 'DONE' ? row.completedAt : now) : null;
    if (patch.timerStartedAt) {
      // Same guard as the database's partial unique index: one running timer per member.
      const clash = this.rows.find((t) => t.memberId === row.memberId && t.id !== row.id && t.timerStartedAt);
      if (clash) throw Errors.timerAlreadyRunning();
    }
    Object.assign(row, patch, { updatedAt: now });
    if (patch.status === 'DONE') row.timerStartedAt = null;
    return { ...row };
  }

  async remove(id: string) {
    // Same as the database transaction: entries keep their time and just lose the link.
    for (const t of this.trackerRows()) if (t.taskId === id) t.taskId = null;
    const index = this.rows.findIndex((t) => t.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}
