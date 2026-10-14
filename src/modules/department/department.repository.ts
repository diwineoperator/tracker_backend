import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../../config/database';
import { Errors } from '../../utils/errors';
import type { DepartmentRecord } from './department.types';

export interface DepartmentRepository {
  list(): Promise<DepartmentRecord[]>;
  findById(id: string): Promise<DepartmentRecord | null>;
  /** Case-insensitive: "fintech" finds "Fintech". */
  findByName(name: string): Promise<DepartmentRecord | null>;
  create(input: { name: string }): Promise<DepartmentRecord>;
  update(id: string, data: { name?: string; isActive?: boolean }): Promise<DepartmentRecord | null>;
  /**
   * Promotes an existing member to lead this department: if it already has a different leader,
   * that account is demoted to a plain member (role MEMBER, memberships cleared) first, then
   * `memberId`'s memberships are cleared and its role set to ADMIN. The caller (the service) has
   * already checked `memberId` is an active plain member of this department.
   */
  assignLeader(id: string, memberId: string): Promise<void>;
  /** Clears this department's leader, if it has one: that account becomes a plain member again (role MEMBER, no memberships). */
  removeLeader(id: string): Promise<void>;
  /** What deleting this department would also remove (for the admin's confirmation warning). Null if it doesn't exist. */
  impact(id: string): Promise<DepartmentDeleteImpact | null>;
  /**
   * Deletes the department in one transaction, with everything that belongs ONLY to it:
   *   - its leader (Admin);
   *   - members who belong to no other department, with all of their data (tasks, time entries,
   *     ledger rows, day closures);
   *   - every task filed under it.
   * A member who ALSO belongs to another department stays, and only loses this membership; time
   * they logged against this department's tasks is kept, just unlinked. Other departments and
   * their data are untouched. Returns false if it does not exist. The caller (the super admin,
   * after an explicit confirmation) owns the decision.
   */
  remove(id: string): Promise<boolean>;
}

export interface DepartmentDeleteImpact {
  /** Accounts that will be deleted: the leader and the members who belong to no other department. */
  members: number;
  /** Members who also belong to another department: they stay, and only lose this membership. */
  keptMembers: number;
  tasks: number;
  timeEntries: number;
  closedDays: number;
}

export class PrismaDepartmentRepository implements DepartmentRepository {
  constructor(private readonly db: Database) {}

  list() {
    return this.db.department.findMany({ orderBy: { name: 'asc' } });
  }

  findById(id: string) {
    return this.db.department.findUnique({ where: { id } });
  }

  findByName(name: string) {
    return this.db.department.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  }

  async create(input: { name: string }) {
    try {
      return await this.db.department.create({ data: input });
    } catch (err) {
      // departments.name is UNIQUE: the final guard against a create race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.departmentNameTaken();
      throw err;
    }
  }

  async update(id: string, data: { name?: string; isActive?: boolean }) {
    try {
      return await this.db.department.update({ where: { id }, data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2025') return null;
        if (err.code === 'P2002') throw Errors.departmentNameTaken();
      }
      throw err;
    }
  }

  async assignLeader(id: string, memberId: string) {
    try {
      await this.db.$transaction(async (tx) => {
        const department = await tx.department.findUnique({ where: { id }, select: { leaderId: true } });
        if (department?.leaderId && department.leaderId !== memberId) {
          await tx.member.update({ where: { id: department.leaderId }, data: { role: 'MEMBER' } });
        }
        // An ADMIN has no memberships (mirrors how one is created) — clear whatever this member had as a MEMBER.
        await tx.memberDepartment.deleteMany({ where: { memberId } });
        await tx.member.update({ where: { id: memberId }, data: { role: 'ADMIN' } });
        await tx.department.update({ where: { id }, data: { leaderId: memberId } });
      });
    } catch (err) {
      // departments.leader_id is UNIQUE (one member leads at most one department): the service
      // already checks this, so a P2002 here means a concurrent request promoted them first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.memberAlreadyLeader();
      throw err;
    }
  }

  async removeLeader(id: string) {
    await this.db.$transaction(async (tx) => {
      const department = await tx.department.findUnique({ where: { id }, select: { leaderId: true } });
      if (!department?.leaderId) return;
      await tx.member.update({ where: { id: department.leaderId }, data: { role: 'MEMBER' } });
      await tx.department.update({ where: { id }, data: { leaderId: null } });
    });
  }

  /** Who a deletion takes with it: the leader, plus members whose ONLY department is this one. */
  private async whoGoes(db: Pick<Database, 'department' | 'memberDepartment'>, id: string) {
    const department = await db.department.findUnique({ where: { id }, select: { leaderId: true } });
    if (!department) return null;
    const inDepartment = (await db.memberDepartment.findMany({ where: { departmentId: id }, select: { memberId: true } })).map((m) => m.memberId);
    const staying = new Set((await db.memberDepartment.findMany({ where: { memberId: { in: inDepartment }, departmentId: { not: id } }, select: { memberId: true } })).map((m) => m.memberId));
    const doomedMembers = inDepartment.filter((m) => !staying.has(m));
    return { doomedMembers, keptMembers: staying.size, leaderId: department.leaderId };
  }

  async impact(id: string) {
    const who = await this.whoGoes(this.db, id);
    if (!who) return null;
    const [tasks, timeEntries, closedDays] = await Promise.all([
      this.db.task.count({ where: { OR: [{ departmentId: id }, { memberId: { in: who.doomedMembers } }] } }),
      this.db.timeTrackerEntry.count({ where: { memberId: { in: who.doomedMembers } } }),
      this.db.dailyClosure.count({ where: { memberId: { in: who.doomedMembers } } }),
    ]);
    return { members: who.doomedMembers.length + (who.leaderId ? 1 : 0), keptMembers: who.keptMembers, tasks, timeEntries, closedDays };
  }

  async remove(id: string) {
    try {
      return await this.db.$transaction(async (tx) => {
        const who = await this.whoGoes(tx, id);
        if (!who) return false;
        const gone = who.doomedMembers;
        // Entries of anyone else (members who stay) that point at a task being deleted keep their time, just lose the link.
        await tx.timeTrackerEntry.updateMany({ where: { memberId: { notIn: gone }, task: { departmentId: id } }, data: { taskId: null } });
        await tx.timeLedgerEntry.deleteMany({ where: { memberId: { in: gone } } });
        await tx.dailyClosure.deleteMany({ where: { memberId: { in: gone } } });
        await tx.timeTrackerEntry.deleteMany({ where: { memberId: { in: gone } } });
        await tx.task.deleteMany({ where: { OR: [{ departmentId: id }, { memberId: { in: gone } }] } });
        // Memberships of the members who stay go with the department (ON DELETE CASCADE); the leader is deleted here.
        await tx.member.deleteMany({ where: { id: { in: [...gone, ...(who.leaderId ? [who.leaderId] : [])] } } });
        await tx.department.delete({ where: { id } });
        return true;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
      throw err;
    }
  }
}
