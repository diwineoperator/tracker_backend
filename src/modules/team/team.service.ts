import { Errors } from '../../utils/errors';
import type { DepartmentRepository } from '../department/department.repository';
import type { MemberRepository } from '../member/member.repository';

export interface TeamDto {
  department: { id: string; name: string };
  leader: { id: string; fullName: string } | null;
  /** The members of this department — names only, never their emails, tasks or time. */
  members: { id: string; fullName: string; isYou: boolean }[];
}

/**
 * What a member may know about the department(s) they belong to (one or two): the name, its leader
 * and who else is in it. Nothing about departments they are not in.
 */
export class TeamService {
  constructor(
    private readonly members: Pick<MemberRepository, 'list' | 'findById'>,
    private readonly departments: Pick<DepartmentRepository, 'list'>,
  ) {}

  async forMember(memberId: string): Promise<{ teams: TeamDto[] }> {
    const me = await this.members.findById(memberId);
    if (!me) throw Errors.memberNotFound();
    const [departments, everyone] = await Promise.all([this.departments.list(), this.members.list()]);

    const teams = departments
      .filter((d) => me.departmentIds.includes(d.id))
      .map((d): TeamDto => {
        const leader = everyone.find((m) => m.id === d.leaderId && m.isActive);
        return {
          department: { id: d.id, name: d.name },
          leader: leader ? { id: leader.id, fullName: leader.fullName } : null,
          members: everyone
            .filter((m) => m.role === 'MEMBER' && m.isActive && m.departmentIds.includes(d.id))
            .map((m) => ({ id: m.id, fullName: m.fullName, isYou: m.id === memberId }))
            .sort((a, b) => a.fullName.localeCompare(b.fullName)),
        };
      })
      .sort((a, b) => a.department.name.localeCompare(b.department.name));
    return { teams };
  }
}
