/** An error whose message is safe to show to the client. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Every client-facing failure the API can produce, in one place. */
export const Errors = {
  validation: (details?: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'The request contains invalid data.', details),
  invalidJson: () => new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.'),
  authRequired: () => new AppError(401, 'AUTH_REQUIRED', 'Authentication is required.'),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'Session expired. Please login again.'),
  tokenInvalid: () => new AppError(401, 'TOKEN_INVALID', 'Session is invalid. Please login again.'),
  tooManyLoginAttempts: () =>
    new AppError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'Too many login attempts. Please try again later.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have access to this resource.'),
  accountDisabled: () =>
    new AppError(403, 'ACCOUNT_DISABLED', 'Your account has been disabled. Please contact the admin.'),
  memberNotFound: () => new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found.'),
  usernameTaken: () => new AppError(409, 'USERNAME_TAKEN', 'That username is already in use.'),
  routeNotFound: () => new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found.'),
  dayClosed: () => new AppError(409, 'DAY_CLOSED', 'This day is closed and can no longer be changed.'),
  dayAlreadyClosed: () => new AppError(409, 'DAY_ALREADY_CLOSED', "Today's ledger has already been closed."),
  durationExceedsAvailable: (availableMinutes: number) =>
    new AppError(409, 'DURATION_EXCEEDS_AVAILABLE', `Duration cannot exceed the ${availableMinutes} minute(s) available since your last entry.`, { availableMinutes }),
  trackerNotFound: () => new AppError(404, 'TRACKER_NOT_FOUND', 'Tracker entry not found.'),
  departmentNotFound: () => new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found.'),
  departmentNameTaken: () => new AppError(409, 'DEPARTMENT_NAME_TAKEN', 'A department with that name already exists.'),
  departmentInactive: () => new AppError(409, 'DEPARTMENT_INACTIVE', 'That department is inactive. Choose an active department.'),
  departmentHasDependencies: (details: { activeMembers: number; openTasks: number }) =>
    new AppError(
      409,
      'DEPARTMENT_HAS_DEPENDENCIES',
      'This department still has active members or open tasks. Reassign or finish them first.',
      details,
    ),
  taskNotFound: () => new AppError(404, 'TASK_NOT_FOUND', 'Task not found.'),
  taskClosed: () => new AppError(409, 'TASK_CLOSED', "This task is done, so you can't log time on it."),
  timerAlreadyRunning: (taskTitle?: string) =>
    new AppError(
      409,
      'TIMER_ALREADY_RUNNING',
      taskTitle ? `You already have a timer running on “${taskTitle}”. Stop or discard it first.` : 'You already have a timer running. Stop or discard it first.',
    ),
  departmentRequired: () => new AppError(400, 'DEPARTMENT_REQUIRED', 'Select a department.'),
  tooManyDepartments: () => new AppError(409, 'TOO_MANY_DEPARTMENTS', 'A member can belong to at most 2 departments.'),
  memberShared: () =>
    new AppError(403, 'MEMBER_SHARED', 'This member also belongs to another department, so only the Super Admin can change them.'),
  departmentHasLeader: () => new AppError(409, 'DEPARTMENT_HAS_LEADER', 'This department already has a leader.'),
  memberAlreadyLeader: () => new AppError(409, 'MEMBER_ALREADY_LEADER', 'This member already leads a department. Remove them as leader first.'),
  departmentNoLeader: () => new AppError(409, 'DEPARTMENT_NO_LEADER', 'That department has no leader to receive requests yet.'),
  leaderDepartmentLocked: () => new AppError(409, 'LEADER_DEPARTMENT_LOCKED', "A leader can't be moved to another department. Make them a member first."),
  attachmentNotFound: () => new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found.'),
  tooManyAttachments: (max: number) => new AppError(409, 'TOO_MANY_ATTACHMENTS', `You can attach at most ${max} files here.`),
  requestClosedForAttachments: () => new AppError(409, 'REQUEST_CLOSED', 'This request is already closed, so its attachments can no longer be changed.'),
  requestClosedForReplies: () => new AppError(409, 'REQUEST_CLOSED', 'This request is closed, so no more replies can be added.'),
  requestNotFound: () => new AppError(404, 'REQUEST_NOT_FOUND', 'Request not found.'),
  memberNotInDepartment: () => new AppError(409, 'MEMBER_NOT_IN_DEPARTMENT', 'That member does not belong to the selected department.'),
  memberInactive: () => new AppError(409, 'MEMBER_INACTIVE', 'That member is disabled and cannot be assigned tasks.'),
  internal: () => new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'),
} as const;
