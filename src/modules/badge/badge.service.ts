import { scopedDepartmentId, type StaffScope } from '../../utils/scope';
import type { RequestRepository } from '../request/request.repository';
import type { TaskRepository } from '../task/task.repository';

export interface MemberBadges {
  /** Tasks handed to the member (and not Done) since `tasksSince` (their last visit to For You). */
  forYou: number;
  /** Their own requests that a leader has answered or moved on since `since` (their last visit to Requests). */
  requests: number;
}

export interface StaffBadges {
  /** Requests waiting for a first response, in the caller's scope. */
  requests: number;
  /** A leader's own For You: tasks handed directly to them (not Done) since they last looked. Absent for the super admin — nothing is ever assigned to them. */
  forYou?: number;
}

/**
 * The little counts next to "For You" and "Requests" in the navigation. Each is derived on the spot from data the
 * caller may already read — a member counts only their own tasks and requests (the id comes from the session), a
 * leader only their department's inbox — so a badge can never reveal something the page behind it would not.
 */
export class BadgeService {
  constructor(
    private readonly tasks: Pick<TaskRepository, 'list'>,
    private readonly requests: Pick<RequestRepository, 'list'>,
  ) {}

  async forMember(memberId: string, since: { requests?: Date; tasks?: Date } = {}): Promise<MemberBadges> {
    const [tasks, requests] = await Promise.all([this.tasks.list({ memberId }), this.requests.list({ fromMemberId: memberId })]);
    return {
      // "New" = assigned (or reassigned) after the member last looked; without a last-visit every open task counts.
      forYou: tasks.filter((t) => t.status !== 'DONE' && (!since.tasks || t.assignedAt > since.tasks)).length,
      // "Answered" = a leader replied or changed the status; unread = that happened after the member last looked.
      requests: requests.filter((r) => (r.status !== 'OPEN' || r.response !== null) && (!since.requests || r.updatedAt > since.requests)).length,
    };
  }

  /** A leader's inbox is their department's; the super admin's is every department's. A leader also gets their own For You count — the super admin never does (nothing is ever assigned to them). */
  async forStaff(scope: StaffScope, tasksSince?: Date): Promise<StaffBadges> {
    const own = scopedDepartmentId(scope);
    const requests = (await this.requests.list({ ...(own && { toDepartmentId: own }), status: 'OPEN' })).length;
    if (scope.kind !== 'department') return { requests };
    const tasks = await this.tasks.list({ memberId: scope.adminId });
    return { requests, forYou: tasks.filter((t) => t.status !== 'DONE' && (!tasksSince || t.assignedAt > tasksSince)).length };
  }
}
