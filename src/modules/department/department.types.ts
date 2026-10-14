export interface DepartmentRecord {
  id: string;
  name: string;
  isActive: boolean;
  /** The Admin who leads it (an account with role ADMIN); null until one is assigned. */
  leaderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A department a task can be handed to the LEADER of — deliberately narrower than `DepartmentDto`
 * (no member/task counts): any staff caller may see this for a department outside their own scope,
 * to pick its leader as an assignee, without that leaking anything else about it.
 */
export interface LeaderTargetDto {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
}

/** What the admin UI sees, with the counts that decide whether it can be deactivated/deleted. */
export interface DepartmentDto {
  id: string;
  name: string;
  isActive: boolean;
  memberCount: number;
  activeMemberCount: number;
  taskCount: number;
  openTaskCount: number;
  /** The department's Admin (leader), or null for one created before leaders existed. */
  leaderId: string | null;
  leaderName: string | null;
  leaderUsername: string | null;
  createdAt: string;
}
