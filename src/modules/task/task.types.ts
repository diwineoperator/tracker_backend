export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Persistence-level shape. */
export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  departmentId: string;
  memberId: string;
  status: TaskStatus;
  /** Local calendar date (YYYY-MM-DD), or null. */
  dueDate: string | null;
  /** When it was last marked Done; null while it is open. */
  completedAt: Date | null;
  /** When the member started their stopwatch on this task; null when none is running. */
  timerStartedAt: Date | null;
  /** The admin's sign-in name. */
  createdBy: string;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskFilter {
  departmentId?: string;
  memberId?: string;
  status?: TaskStatus;
  /** Who assigned it (the staff account's sign-in name) — used to find tasks a leader delegated out. */
  createdBy?: string;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  dueDate: string | null;
  departmentId: string;
  departmentName: string;
  memberId: string;
  memberName: string;
  memberUsername: string;
  /** MEMBER = assigned to one of a department's members; ADMIN = handed to another department's leader. */
  memberRole: 'MEMBER' | 'ADMIN';
  /** Minutes of Time Tracker entries logged against this task (the tracker's own duration, not gap time). */
  loggedMinutes: number;
  completedAt: string | null;
  /** ISO instant the stopwatch was started; null when not running. */
  timerStartedAt: string | null;
  createdBy: string;
  /** `createdBy` resolved to a display name — "Super Admin", or the assigning leader's own name. */
  createdByName: string;
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
}
