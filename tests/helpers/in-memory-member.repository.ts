import { randomUUID } from 'node:crypto';
import type { MemberDeleteImpact, MemberRepository } from '../../src/modules/member/member.repository';
import { MAX_MEMBER_DEPARTMENTS, type MemberRecord, type MemberRoleValue } from '../../src/modules/member/member.types';
import { Errors } from '../../src/utils/errors';

/** Behaves like the Prisma repository, including the unique-username rule. */
export class InMemoryMemberRepository implements MemberRepository {
  readonly rows: MemberRecord[] = [];

  /** Wired by buildTestApp to the other fakes, so deleting a member cascades like the real transaction. */
  related: { impact: (memberId: string) => MemberDeleteImpact; removeAll: (memberId: string) => void } = {
    impact: () => ({ tasks: 0, timeEntries: 0, closedDays: 0 }),
    removeAll: () => {},
  };

  async create(input: { username: string; fullName: string; passwordHash: string; departmentIds: string[]; role?: MemberRoleValue }) {
    if (this.rows.some((r) => r.username === input.username)) throw Errors.usernameTaken();
    if (input.departmentIds.length > MAX_MEMBER_DEPARTMENTS) throw Errors.tooManyDepartments(); // the database trigger's twin
    const now = new Date();
    const row: MemberRecord = { id: randomUUID(), ...input, role: input.role ?? 'MEMBER', isActive: true, createdAt: now, updatedAt: now };
    this.rows.push(row);
    return { ...row, departmentIds: [...row.departmentIds] };
  }

  async findById(id: string) {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row, departmentIds: [...row.departmentIds] } : null;
  }

  async findByUsername(username: string) {
    const row = this.rows.find((r) => r.username === username);
    return row ? { ...row, departmentIds: [...row.departmentIds] } : null;
  }

  async list(filter: { departmentId?: string } = {}) {
    return [...this.rows]
      .reverse()
      .filter((r) => !filter.departmentId || r.departmentIds.includes(filter.departmentId))
      .map((r) => ({ ...r, departmentIds: [...r.departmentIds] }));
  }

  /** An ADMIN's only departmentId is the department they lead (set by InMemoryDepartmentRepository.setLeader). */
  async findLeader(departmentId: string) {
    const row = this.rows.find((r) => r.role === 'ADMIN' && r.departmentIds.includes(departmentId));
    return row ? { ...row, departmentIds: [...row.departmentIds] } : null;
  }

  async update(id: string, data: { fullName?: string; isActive?: boolean; passwordHash?: string; departmentIds?: string[] }) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (data.departmentIds && data.departmentIds.length > MAX_MEMBER_DEPARTMENTS) throw Errors.tooManyDepartments();
    Object.assign(row, data, { updatedAt: new Date() });
    return { ...row, departmentIds: [...row.departmentIds] };
  }

  async impact(id: string) {
    return this.rows.some((r) => r.id === id) ? this.related.impact(id) : null;
  }

  /** Like the real transaction: their tasks, time entries, ledger rows and day closures go with them. */
  async remove(id: string) {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.related.removeAll(id);
    this.rows.splice(index, 1);
    return true;
  }
}
