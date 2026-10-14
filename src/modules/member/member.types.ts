export const MEMBER_ROLES = ['MEMBER', 'ADMIN'] as const;
/** A member can belong to at most this many departments (also enforced by a database trigger). */
export const MAX_MEMBER_DEPARTMENTS = 2;
/** ADMIN = the leader of one department. The super admin is not a member row. */
export type MemberRoleValue = (typeof MEMBER_ROLES)[number];

/** Persistence-level shape. Contains the password hash: never sent to clients. */
export interface MemberRecord {
  id: string;
  username: string;
  fullName: string;
  passwordHash: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The departments this account belongs to: a MEMBER's memberships (1..2, or none for one created before
   * departments existed); for an ADMIN, the one department they lead.
   */
  departmentIds: string[];
  role: MemberRoleValue;
}

/** What the admin UI sees. No password hash, ever. */
export interface MemberDto {
  id: string;
  username: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  departmentIds: string[];
  /** True when the member belongs to more than one department. */
  shared: boolean;
  role: MemberRoleValue;
}
