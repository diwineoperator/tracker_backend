import { Errors } from '../../utils/errors';
import { inScope, type StaffScope } from '../../utils/scope';
import type { MemberRepository } from '../member/member.repository';
import type { TaskRepository } from '../task/task.repository';
import type { DepartmentRepository } from './department.repository';
import type { DepartmentDto, DepartmentRecord, LeaderTargetDto } from './department.types';
import type { CreateDepartmentBody, UpdateDepartmentBody } from './department.validation';

interface Usage {
  memberCount: number;
  activeMemberCount: number;
  taskCount: number;
  openTaskCount: number;
  leaderId: string | null;
  leaderName: string | null;
  leaderUsername: string | null;
}

const toDto = (r: DepartmentRecord, u: Usage): DepartmentDto => ({
  id: r.id,
  name: r.name,
  isActive: r.isActive,
  ...u,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Department management is the super admin's alone; an Admin (leader) can only READ their own
 * department. A department is "in use" by the members
 * assigned to it and the tasks filed under it; those counts (computed here from
 * the member/task repositories, not duplicated in SQL) decide whether it can be
 * deactivated or deleted — never a silent cascade.
 */
export class DepartmentService {
  constructor(
    private readonly repo: DepartmentRepository,
    private readonly members: Pick<MemberRepository, 'list' | 'findById'>,
    private readonly tasks: Pick<TaskRepository, 'list'>,
  ) {}

  /** The super admin sees every department; a leader sees only their own. */
  async list(scope: StaffScope): Promise<DepartmentDto[]> {
    return (await this.listAll()).filter((d) => inScope(scope, d.id));
  }

  /**
   * Every OTHER department that currently has a leader — enough to hand a task to one (id, name,
   * leader), nothing else. Unlike `list()`, this deliberately crosses department boundaries: it's
   * how a leader finds another department's leader to delegate to (task assignment's own
   * "Leader → Other Leader" rule already re-checks this server-side; this is just what fills the
   * picker). A leader never sees their own department here — assigning to themselves isn't a thing.
   */
  async leaderTargets(scope: StaffScope): Promise<LeaderTargetDto[]> {
    const [departments, members] = await Promise.all([this.repo.list(), this.members.list()]);
    const nameOf = new Map(members.map((m) => [m.id, m.fullName]));
    return departments
      .filter((d) => d.leaderId && !(scope.kind === 'department' && d.id === scope.departmentId))
      .map((d) => ({ id: d.id, name: d.name, leaderId: d.leaderId!, leaderName: nameOf.get(d.leaderId!) ?? 'Unknown' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async listAll(): Promise<DepartmentDto[]> {
    const [departments, members, tasks] = await Promise.all([this.repo.list(), this.members.list(), this.tasks.list({})]);
    return departments.map((d) => {
      const leader = d.leaderId ? members.find((m) => m.id === d.leaderId) : undefined;
      const ms = members.filter((m) => m.role === 'MEMBER' && m.departmentIds.includes(d.id)); // the leader isn't one of a department's members
      const ts = tasks.filter((t) => t.departmentId === d.id);
      return toDto(d, {
        leaderId: leader?.id ?? null,
        leaderName: leader?.fullName ?? null,
        leaderUsername: leader?.username ?? null,
        memberCount: ms.length,
        activeMemberCount: ms.filter((m) => m.isActive).length,
        taskCount: ts.length,
        openTaskCount: ts.filter((t) => t.status !== 'DONE').length,
      });
    });
  }

  private async one(id: string): Promise<DepartmentDto> {
    const found = (await this.listAll()).find((d) => d.id === id);
    if (!found) throw Errors.departmentNotFound();
    return found;
  }

  async create(input: CreateDepartmentBody): Promise<DepartmentDto> {
    if (await this.repo.findByName(input.name)) throw Errors.departmentNameTaken();
    const created = await this.repo.create({ name: input.name });
    return this.one(created.id);
  }

  /**
   * Assigns or changes a department's leader by promoting an EXISTING, active member who already
   * belongs to it (never a brand-new account). If it already has a different leader, that account
   * is demoted back to a plain member (role MEMBER, no department memberships — the super admin
   * can add them to one afterward) in the same transaction, so a department never has two leaders
   * and a member is never leading two departments at once.
   */
  async assignLeader(id: string, memberId: string): Promise<DepartmentDto> {
    if (!(await this.repo.findById(id))) throw Errors.departmentNotFound();
    const member = await this.members.findById(memberId);
    if (!member) throw Errors.memberNotFound();
    if (!member.isActive) throw Errors.memberInactive();
    // Only a plain member can be promoted — this is what keeps "one department per leader" true
    // without a special-case check: an account leading department X already has role ADMIN.
    if (member.role === 'ADMIN') throw Errors.memberAlreadyLeader();
    if (!member.departmentIds.includes(id)) throw Errors.memberNotInDepartment();
    await this.repo.assignLeader(id, memberId);
    return this.one(id);
  }

  /** Removes a department's leader (a no-op if it has none): they become a plain member again, with no department. */
  async removeLeader(id: string): Promise<DepartmentDto> {
    if (!(await this.repo.findById(id))) throw Errors.departmentNotFound();
    await this.repo.removeLeader(id);
    return this.one(id);
  }

  async update(id: string, input: UpdateDepartmentBody): Promise<DepartmentDto> {
    const existing = await this.repo.findById(id);
    if (!existing) throw Errors.departmentNotFound();

    if (input.name !== undefined) {
      const clash = await this.repo.findByName(input.name);
      if (clash && clash.id !== id) throw Errors.departmentNameTaken();
    }
    // Deactivating hides it from every "pick a department" list, so it must have
    // nobody active in it and nothing still open under it.
    if (input.isActive === false && existing.isActive) {
      const current = await this.one(id);
      if (current.activeMemberCount > 0 || current.openTaskCount > 0) {
        throw Errors.departmentHasDependencies({ activeMembers: current.activeMemberCount, openTasks: current.openTaskCount });
      }
    }

    const updated = await this.repo.update(id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    });
    if (!updated) throw Errors.departmentNotFound();
    return this.one(id);
  }

  /** Admin only: what deleting this department would also remove — shown as a warning before they confirm. */
  async impact(id: string) {
    const impact = await this.repo.impact(id);
    if (!impact) throw Errors.departmentNotFound();
    return impact;
  }

  async remove(id: string): Promise<void> {
    // Any department can be deleted, with everything under it (the admin confirmed a warning listing exactly what).
    if (!(await this.repo.remove(id))) throw Errors.departmentNotFound();
  }
}
