import bcrypt from 'bcryptjs';
import { Errors } from '../../utils/errors';
import { inScope, scopedDepartmentId, type StaffScope } from '../../utils/scope';
import type { DepartmentRepository } from '../department/department.repository';
import type { MemberRepository } from './member.repository';
import { MAX_MEMBER_DEPARTMENTS, type MemberDto, type MemberRecord } from './member.types';
import type { CreateMemberBody, UpdateMemberBody } from './member.validation';

export const DEFAULT_PASSWORD_COST = 12;

const toDto = (r: MemberRecord, scope: StaffScope): MemberDto => ({
  id: r.id,
  username: r.username,
  fullName: r.fullName,
  isActive: r.isActive,
  createdAt: r.createdAt.toISOString(),
  // A leader is only told about their own department — never which other one a shared member also belongs to.
  departmentIds: scope.kind === 'all' ? r.departmentIds : r.departmentIds.filter((id) => id === scope.departmentId),
  shared: r.departmentIds.length > 1,
  role: r.role,
});

/**
 * Account management. The super admin manages every account; an Admin (leader) manages only the
 * MEMBERS of their own department — and only members who belong to no other department (a member
 * shared with another department is the super admin's to change, so one leader can't edit what
 * another department depends on). Everything is checked against the `StaffScope` built from the
 * caller's session, and something outside the scope is reported as "not found".
 */
export class MemberService {
  private readonly adminUsername: string;

  constructor(
    private readonly repo: MemberRepository,
    private readonly departments: Pick<DepartmentRepository, 'findById'>,
    adminUsername: string,
    private readonly passwordCost: number = DEFAULT_PASSWORD_COST,
  ) {
    this.adminUsername = adminUsername.trim().toLowerCase();
  }

  /** The super admin sees everyone (leaders included); a leader sees only the members of their department. */
  async list(scope: StaffScope): Promise<MemberDto[]> {
    const rows = await this.repo.list({ departmentId: scopedDepartmentId(scope) });
    return rows.filter((m) => scope.kind === 'all' || m.role === 'MEMBER').map((m) => toDto(m, scope));
  }

  async create(scope: StaffScope, input: CreateMemberBody): Promise<MemberDto> {
    let departmentIds: string[];
    if (scope.kind === 'department') {
      // A leader only ever adds a member to their own department (and only that one).
      if (input.departmentIds && !(input.departmentIds.length === 1 && input.departmentIds[0] === scope.departmentId)) throw Errors.forbidden();
      departmentIds = [scope.departmentId];
    } else {
      if (!input.departmentIds?.length) throw Errors.departmentRequired();
      departmentIds = input.departmentIds;
    }
    await this.requireUsernameFree(input.username);
    for (const id of departmentIds) await this.requireAssignableDepartment(id);
    const passwordHash = await bcrypt.hash(input.password, this.passwordCost);
    const created = await this.repo.create({ username: input.username, fullName: input.fullName, passwordHash, departmentIds });
    return toDto(created, scope);
  }

  private async requireUsernameFree(username: string): Promise<void> {
    // The super admin's login lives in the environment, so its name is reserved.
    if (username === this.adminUsername || (await this.repo.findByUsername(username))) throw Errors.usernameTaken();
  }

  async update(scope: StaffScope, id: string, input: UpdateMemberBody): Promise<MemberDto> {
    const existing = await this.requireInScope(scope, id);

    if (scope.kind === 'department') {
      // A leader edits their own members' name / password / enabled flag — nothing structural, and
      // never a member who also belongs to another department.
      if (input.departmentIds !== undefined) throw Errors.forbidden();
      if (existing.departmentIds.length > 1) throw Errors.memberShared();
    } else if (input.departmentIds !== undefined) {
      // A leader's department is fixed by the department itself; a member's memberships are replaced (1..2).
      if (existing.role === 'ADMIN') throw Errors.leaderDepartmentLocked();
      if (input.departmentIds.length > MAX_MEMBER_DEPARTMENTS) throw Errors.tooManyDepartments();
      // A department they are already in stays allowed even if since deactivated; a NEW one must be active.
      for (const dept of input.departmentIds.filter((d) => !existing.departmentIds.includes(d))) await this.requireAssignableDepartment(dept);
    }

    const updated = await this.repo.update(id, {
      ...(input.fullName !== undefined && { fullName: input.fullName }),
      ...(input.departmentIds !== undefined && { departmentIds: input.departmentIds }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.password !== undefined && { passwordHash: await bcrypt.hash(input.password, this.passwordCost) }),
    });
    if (!updated) throw Errors.memberNotFound();
    return toDto(updated, scope);
  }

  private async requireAssignableDepartment(departmentId: string): Promise<void> {
    const department = await this.departments.findById(departmentId);
    if (!department) throw Errors.departmentNotFound();
    if (!department.isActive) throw Errors.departmentInactive();
  }

  /** The account, if the caller may manage it — otherwise "not found" (never "not yours"). */
  private async requireInScope(scope: StaffScope, id: string): Promise<MemberRecord> {
    const member = await this.repo.findById(id);
    if (!member || !inScope(scope, member.departmentIds)) throw Errors.memberNotFound();
    if (scope.kind === 'department' && member.role !== 'MEMBER') throw Errors.memberNotFound(); // a leader can't manage a leader
    return member;
  }

  /** What deleting this member would also remove — shown as a warning before they confirm. */
  async impact(scope: StaffScope, id: string) {
    const member = await this.requireInScope(scope, id);
    if (scope.kind === 'department' && member.departmentIds.length > 1) throw Errors.memberShared();
    const impact = await this.repo.impact(id);
    if (!impact) throw Errors.memberNotFound();
    return impact;
  }

  /** Deletes the member and everything that belongs only to them (see the repository). */
  async remove(scope: StaffScope, id: string): Promise<void> {
    const member = await this.requireInScope(scope, id);
    if (scope.kind === 'department' && member.departmentIds.length > 1) throw Errors.memberShared();
    if (!(await this.repo.remove(id))) throw Errors.memberNotFound();
  }
}
