/**
 * What an admin-side caller may see and change:
 *   all        — the super admin: every department, member, task, request and ledger.
 *   department — an Admin (a department's leader): only the department they lead and its members.
 * Built by `requireStaff` from the database on every request — never from anything the client sends.
 */
export type StaffScope = { kind: 'all' } | { kind: 'department'; departmentId: string; adminId: string };

/**
 * True if something that belongs to the given department(s) is inside `scope`. A member can belong to
 * several departments, so a member is in a leader's scope when ANY of theirs is the leader's department.
 */
export const inScope = (scope: StaffScope, departmentIds: string | readonly string[] | null | undefined): boolean => {
  if (scope.kind === 'all') return true;
  if (!departmentIds) return false;
  return typeof departmentIds === 'string' ? departmentIds === scope.departmentId : departmentIds.includes(scope.departmentId);
};

/** The one department a scope is limited to, or undefined for "all". */
export const scopedDepartmentId = (scope: StaffScope): string | undefined => (scope.kind === 'department' ? scope.departmentId : undefined);
