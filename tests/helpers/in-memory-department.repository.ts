import { randomUUID } from 'node:crypto';
import type { DepartmentDeleteImpact, DepartmentRepository } from '../../src/modules/department/department.repository';
import type { DepartmentRecord } from '../../src/modules/department/department.types';
import type { MemberRecord } from '../../src/modules/member/member.types';
import { Errors } from '../../src/utils/errors';

/** Behaves like the Prisma repository, including the unique-name rule. Usage counts live in the service. */
export class InMemoryDepartmentRepository implements DepartmentRepository {
  readonly rows: DepartmentRecord[] = [];

  /** The member rows, so a department's leader (the ADMIN whose only department it is) can be derived like the database's leader_id. */
  constructor(private readonly memberRows: () => MemberRecord[] = () => []) {}

  private withLeader(r: DepartmentRecord): DepartmentRecord {
    return { ...r, leaderId: this.memberRows().find((m) => m.role === 'ADMIN' && m.departmentIds.includes(r.id))?.id ?? null };
  }

  async assignLeader(id: string, memberId: string) {
    const member = this.memberRows().find((m) => m.id === memberId);
    if (!member || !this.rows.some((r) => r.id === id)) return;
    const current = this.memberRows().find((m) => m.role === 'ADMIN' && m.departmentIds.includes(id) && m.id !== memberId);
    if (current) {
      current.role = 'MEMBER';
      current.departmentIds = [];
    }
    member.role = 'ADMIN';
    member.departmentIds = [id];
  }

  async removeLeader(id: string) {
    const leader = this.memberRows().find((m) => m.role === 'ADMIN' && m.departmentIds.includes(id));
    if (!leader) return;
    leader.role = 'MEMBER';
    leader.departmentIds = [];
  }

  /** Wired by buildTestApp so deleting a department cascades like the real transaction. */
  related: { impact: (departmentId: string) => DepartmentDeleteImpact; removeAll: (departmentId: string) => void } = {
    impact: () => ({ members: 0, keptMembers: 0, tasks: 0, timeEntries: 0, closedDays: 0 }),
    removeAll: () => {},
  };

  async impact(id: string) {
    return this.rows.some((r) => r.id === id) ? this.related.impact(id) : null;
  }

  async list() {
    return [...this.rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.withLeader(r));
  }

  async findById(id: string) {
    const row = this.rows.find((r) => r.id === id);
    return row ? this.withLeader(row) : null;
  }

  async findByName(name: string) {
    const row = this.rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
    return row ? this.withLeader(row) : null;
  }

  async create(input: { name: string }) {
    if (this.rows.some((r) => r.name === input.name)) throw Errors.departmentNameTaken();
    const now = new Date();
    const row: DepartmentRecord = { id: randomUUID(), name: input.name, isActive: true, leaderId: null, createdAt: now, updatedAt: now };
    this.rows.push(row);
    return this.withLeader(row);
  }

  async update(id: string, data: { name?: string; isActive?: boolean }) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (data.name !== undefined && this.rows.some((r) => r.id !== id && r.name === data.name)) throw Errors.departmentNameTaken();
    Object.assign(row, data, { updatedAt: new Date() });
    return this.withLeader(row);
  }

  /** Like the real transaction: its members (with all their data) and its tasks go with it. */
  async remove(id: string) {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.related.removeAll(id);
    this.rows.splice(index, 1);
    return true;
  }
}
