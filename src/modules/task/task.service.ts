import { Errors } from '../../utils/errors';
import type { DepartmentRepository } from '../department/department.repository';
import type { Clock } from '../../utils/clock';
import { inScope, scopedDepartmentId, type StaffScope } from '../../utils/scope';
import type { MemberRepository } from '../member/member.repository';
import type { TaskRepository } from './task.repository';
import type { TaskDto, TaskFilter, TaskRecord, TaskStatus } from './task.types';
import type { CreateTaskBody, UpdateTaskBody } from './task.validation';

/**
 * Admin creates/assigns/edits tasks; a member only ever reads their own. Access
 * control lives here and in the routes (admin router vs member router) — never in
 * the client. A task belongs to one department and is assigned to one member OF
 * that department; a disabled member or an inactive department can't receive new
 * work.
 */
export class TaskService {
  constructor(
    private readonly repo: TaskRepository,
    private readonly members: Pick<MemberRepository, 'list' | 'findById'>,
    private readonly departments: Pick<DepartmentRepository, 'list' | 'findById'>,
    private readonly clock: Clock,
    /** The super admin's sign-in name — `createdBy` shows as "Super Admin" for them, a leader's own name otherwise. */
    private readonly adminUsername: string,
  ) {}

  /** Admin side: every task the caller's scope covers (a leader: their department's), optionally narrowed by department / member / status. */
  /**
   * `callerUsername` lets a leader ALSO see tasks they delegated to another department's leader —
   * read-only: it doesn't widen `update`/`remove`, which still 404 once a task has left their
   * department (delegation transfers who manages it; this only restores "can I check on it"). The
   * super admin already sees everything, so this only ever adds rows for a department-scoped caller.
   */
  async listAll(scope: StaffScope, filter: TaskFilter, callerUsername?: string): Promise<TaskDto[]> {
    const own = scopedDepartmentId(scope);
    if (!own) return this.toDtos(await this.repo.list(filter)); // super admin: unrestricted, as today
    // A leader can't widen their own department's view with ?departmentId=… — their own always wins.
    const [inDepartment, delegatedOut] = await Promise.all([
      this.repo.list({ ...filter, departmentId: own }),
      callerUsername ? this.repo.list({ ...filter, createdBy: callerUsername }) : Promise.resolve([]),
    ]);
    const merged = [...inDepartment, ...delegatedOut.filter((t) => t.departmentId !== own)];
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return this.toDtos(merged);
  }

  /**
   * A member's own tasks — the id comes from the authenticated session (the caller
   * passes `currentMemberId`), never from the request. Open work first, soonest
   * due date first, finished work last.
   */
  async listForMember(memberId: string): Promise<TaskDto[]> {
    const dtos = await this.toDtos(await this.repo.list({ memberId }));
    const rank = (t: TaskDto) => (t.status === 'DONE' ? 1 : 0);
    return dtos.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  async create(scope: StaffScope, createdBy: string, input: CreateTaskBody): Promise<TaskDto> {
    const departmentId = await this.resolveAssignment(scope, input.memberId, input.departmentId);
    const created = await this.repo.create({
      title: input.title,
      description: input.description ?? null,
      departmentId,
      memberId: input.memberId,
      status: input.status ?? 'TODO',
      dueDate: input.dueDate ?? null,
      createdBy,
    });
    return this.one(created);
  }

  async update(scope: StaffScope, id: string, input: UpdateTaskBody): Promise<TaskDto> {
    const existing = await this.repo.findById(id);
    if (!existing || !inScope(scope, existing.departmentId)) throw Errors.taskNotFound();

    // Only re-validate (and possibly re-resolve) the assignment when it actually changes — editing
    // the title/status of a task whose member was since disabled must still work.
    const memberId = input.memberId ?? existing.memberId;
    const departmentId =
      input.memberId !== undefined || input.departmentId !== undefined
        ? await this.resolveAssignment(scope, memberId, input.departmentId, existing.departmentId)
        : existing.departmentId;

    const updated = await this.repo.update(id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(departmentId !== existing.departmentId && { departmentId }),
      ...(input.memberId !== undefined && { memberId: input.memberId }),
      // Reassigning hands the task to someone else — the previous member's stopwatch must not travel with it.
      ...(memberId !== existing.memberId && { timerStartedAt: null, assignedAt: this.clock.now() }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
    });
    if (!updated) throw Errors.taskNotFound();
    return this.one(updated);
  }

  /**
   * A member reporting progress on their OWN task. Someone else's task is reported as
   * not found (never confirming it exists), and only the status can change.
   */
  async updateStatusForMember(memberId: string, id: string, status: TaskStatus): Promise<TaskDto> {
    const existing = await this.repo.findById(id);
    if (!existing || existing.memberId !== memberId) throw Errors.taskNotFound();
    const updated = await this.repo.update(id, { status });
    if (!updated) throw Errors.taskNotFound();
    return this.one(updated);
  }

  /**
   * A member's stopwatch on their OWN task — only the start instant is stored. One at a
   * time (the database enforces it too); starting it on a To-do task also marks it In
   * progress. Starting one that is already running is a harmless no-op. Stopping happens
   * in the Add Tracker form: saving time against the task ends the stopwatch.
   */
  async startTimer(memberId: string, id: string): Promise<TaskDto> {
    const task = await this.requireOwned(memberId, id);
    if (task.status === 'DONE') throw Errors.taskClosed();
    if (task.timerStartedAt) return this.one(task);
    const running = (await this.repo.list({ memberId })).find((t) => t.timerStartedAt);
    if (running) throw Errors.timerAlreadyRunning(running.title);
    const updated = await this.repo.update(id, { timerStartedAt: this.clock.now(), ...(task.status === 'TODO' && { status: 'IN_PROGRESS' as const }) });
    if (!updated) throw Errors.taskNotFound();
    return this.one(updated);
  }

  /** Throws the running stopwatch away without logging anything. */
  async discardTimer(memberId: string, id: string): Promise<TaskDto> {
    await this.requireOwned(memberId, id);
    const updated = await this.repo.update(id, { timerStartedAt: null });
    if (!updated) throw Errors.taskNotFound();
    return this.one(updated);
  }

  /** Someone else's task is reported as not found — never confirms it exists. */
  private async requireOwned(memberId: string, id: string): Promise<TaskRecord> {
    const task = await this.repo.findById(id);
    if (!task || task.memberId !== memberId) throw Errors.taskNotFound();
    return task;
  }

  /** Admin may delete any task; time already logged against it stays, just no longer linked to it. */
  async remove(scope: StaffScope, id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing || !inScope(scope, existing.departmentId)) throw Errors.taskNotFound();
    if (!(await this.repo.remove(id))) throw Errors.taskNotFound();
  }

  /**
   * Resolves and authorizes WHO a task is for, returning the department it belongs to (or throwing).
   * The target's role decides which of two rules applies:
   *
   *  - MEMBER: `departmentId` is required (their own — chosen explicitly, or kept from the existing
   *    task on an edit) and must be within the caller's scope (a leader: their own department only;
   *    the super admin: any). Same checks and error precedence as before this method existed:
   *    department exists → department active → member active → member actually belongs to it.
   *
   *  - ADMIN (another department's leader): `departmentId` is never taken from the client — it's the
   *    one department they lead. A super admin (scope 'all') may target any leader; a department-
   *    scoped leader may target any leader EXCEPT the one they lead themselves (self-assignment
   *    isn't a thing — they assign to their own members directly instead). This one branch is both
   *    "Leader → Other Leader" and "Super Admin → Any Leader" from the permission model: `inScope`'s
   *    existing all-vs-one-department distinction is all that's needed to tell them apart.
   *
   * `fallbackDepartmentId` is what to fall back to for a MEMBER target when the caller didn't send
   * an explicit `departmentId` (an edit that only changes `memberId`, keeping the task's department).
   */
  private async resolveAssignment(scope: StaffScope, memberId: string, explicitDepartmentId: string | undefined, fallbackDepartmentId?: string): Promise<string> {
    const target = await this.members.findById(memberId);
    if (!target) throw Errors.memberNotFound();

    let departmentId: string;
    if (target.role === 'ADMIN') {
      const led = target.departmentIds[0];
      if (!led) throw Errors.memberNotInDepartment(); // an Admin with no led department — shouldn't happen, but never assignable
      if (explicitDepartmentId !== undefined && explicitDepartmentId !== led) throw Errors.forbidden(); // the client tried to lie about it
      if (scope.kind === 'department' && scope.departmentId === led) throw Errors.forbidden(); // no self-assignment
      departmentId = led;
    } else {
      departmentId = explicitDepartmentId ?? fallbackDepartmentId ?? '';
      if (!departmentId) throw Errors.departmentRequired();
      if (!inScope(scope, departmentId)) throw Errors.forbidden();
    }

    const department = await this.departments.findById(departmentId);
    if (!department) throw Errors.departmentNotFound();
    if (!department.isActive) throw Errors.departmentInactive();
    if (!target.isActive) throw Errors.memberInactive();
    if (target.role === 'MEMBER' && !target.departmentIds.includes(departmentId)) throw Errors.memberNotInDepartment();
    return departmentId;
  }

  private async one(record: TaskRecord): Promise<TaskDto> {
    return (await this.toDtos([record]))[0]!;
  }

  private async toDtos(records: TaskRecord[]): Promise<TaskDto[]> {
    const [members, departments] = await Promise.all([this.members.list(), this.departments.list()]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const nameByUsername = new Map(members.map((m) => [m.username, m.fullName]));
    const departmentById = new Map(departments.map((d) => [d.id, d]));
    const minutes = await this.repo.loggedMinutes(records.map((r) => r.id));
    return records.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      dueDate: r.dueDate,
      departmentId: r.departmentId,
      departmentName: departmentById.get(r.departmentId)?.name ?? 'Unknown department',
      memberId: r.memberId,
      memberName: memberById.get(r.memberId)?.fullName ?? 'Unknown member',
      memberUsername: memberById.get(r.memberId)?.username ?? '',
      memberRole: memberById.get(r.memberId)?.role ?? 'MEMBER',
      loggedMinutes: minutes.get(r.id) ?? 0,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      timerStartedAt: r.timerStartedAt ? r.timerStartedAt.toISOString() : null,
      createdBy: r.createdBy,
      // The super admin's sign-in name is an env value, not a member row — resolved by name, not id.
      createdByName: r.createdBy === this.adminUsername ? 'Super Admin' : (nameByUsername.get(r.createdBy) ?? r.createdBy),
      assignedAt: r.assignedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}
