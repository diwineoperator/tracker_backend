import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../../config/database';
import { Errors } from '../../utils/errors';
import type { MemberRecord, MemberRoleValue } from './member.types';

export interface MemberRepository {
  /** `departmentIds` are the memberships of a MEMBER. An ADMIN is created with none — the department's `leaderId` links them. */
  create(input: { username: string; fullName: string; passwordHash: string; departmentIds: string[]; role?: MemberRoleValue }): Promise<MemberRecord>;
  findById(id: string): Promise<MemberRecord | null>;
  findByUsername(username: string): Promise<MemberRecord | null>;
  /** With `departmentId`: the members of that department (its leader too). */
  list(filter?: { departmentId?: string }): Promise<MemberRecord[]>;
  /** The Admin who leads a department, if it has one. */
  findLeader(departmentId: string): Promise<MemberRecord | null>;
  /** `departmentIds` REPLACES the member's memberships. */
  update(id: string, data: { fullName?: string; isActive?: boolean; passwordHash?: string; departmentIds?: string[] }): Promise<MemberRecord | null>;
  /** What deleting this member would also remove (for the admin's confirmation warning). Null if they don't exist. */
  impact(id: string): Promise<MemberDeleteImpact | null>;
  /**
   * Deletes a member AND everything that belongs only to them — tasks, time entries (with their
   * ledger rows) and day closures — in one transaction. Returns false if they do not exist.
   * The caller (an admin, after an explicit confirmation) owns the decision.
   */
  remove(id: string): Promise<boolean>;
}

export interface MemberDeleteImpact {
  tasks: number;
  timeEntries: number;
  closedDays: number;
}

const include = { memberships: { select: { departmentId: true } }, ledDepartment: { select: { id: true } } } satisfies Prisma.MemberInclude;
type MemberRow = Prisma.MemberGetPayload<{ include: typeof include }>;

/** The uniform view of "which departments": a member's memberships, or the one department an ADMIN leads. */
const toRecord = ({ memberships, ledDepartment, ...m }: MemberRow): MemberRecord => ({
  ...m,
  departmentIds: m.role === 'ADMIN' ? (ledDepartment ? [ledDepartment.id] : []) : memberships.map((x) => x.departmentId),
});

export class PrismaMemberRepository implements MemberRepository {
  constructor(private readonly db: Database) {}

  async create(input: { username: string; fullName: string; passwordHash: string; departmentIds: string[]; role?: MemberRoleValue }) {
    const { departmentIds, ...data } = input;
    try {
      const row = await this.db.member.create({
        data: { ...data, memberships: { create: departmentIds.map((departmentId) => ({ departmentId })) } },
        include,
      });
      return toRecord(row);
    } catch (err) {
      // members.username is UNIQUE: the final guard against a create race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.usernameTaken();
      throw err;
    }
  }

  async findById(id: string) {
    const row = await this.db.member.findUnique({ where: { id }, include });
    return row ? toRecord(row) : null;
  }

  async findByUsername(username: string) {
    const row = await this.db.member.findUnique({ where: { username }, include });
    return row ? toRecord(row) : null;
  }

  async list(filter: { departmentId?: string } = {}) {
    const rows = await this.db.member.findMany({
      where: filter.departmentId
        ? { OR: [{ memberships: { some: { departmentId: filter.departmentId } } }, { ledDepartment: { is: { id: filter.departmentId } } }] }
        : {},
      include,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async findLeader(departmentId: string) {
    const row = await this.db.member.findFirst({ where: { ledDepartment: { is: { id: departmentId } } }, include });
    return row ? toRecord(row) : null;
  }

  async update(id: string, data: { fullName?: string; isActive?: boolean; passwordHash?: string; departmentIds?: string[] }) {
    const { departmentIds, ...fields } = data;
    try {
      const row = await this.db.$transaction(async (tx) => {
        if (departmentIds !== undefined) {
          await tx.memberDepartment.deleteMany({ where: { memberId: id, departmentId: { notIn: departmentIds } } });
          const have = new Set((await tx.memberDepartment.findMany({ where: { memberId: id }, select: { departmentId: true } })).map((m) => m.departmentId));
          const add = departmentIds.filter((d) => !have.has(d));
          if (add.length > 0) await tx.memberDepartment.createMany({ data: add.map((departmentId) => ({ memberId: id, departmentId })) });
        }
        return tx.member.update({ where: { id }, data: fields, include });
      });
      return toRecord(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  }

  async impact(id: string) {
    if (!(await this.db.member.findUnique({ where: { id }, select: { id: true } }))) return null;
    const [tasks, timeEntries, closedDays] = await Promise.all([
      this.db.task.count({ where: { memberId: id } }),
      this.db.timeTrackerEntry.count({ where: { memberId: id } }),
      this.db.dailyClosure.count({ where: { memberId: id } }),
    ]);
    return { tasks, timeEntries, closedDays };
  }

  async remove(id: string) {
    try {
      await this.db.$transaction([
        this.db.timeLedgerEntry.deleteMany({ where: { memberId: id } }),
        this.db.dailyClosure.deleteMany({ where: { memberId: id } }),
        this.db.timeTrackerEntry.deleteMany({ where: { memberId: id } }),
        this.db.task.deleteMany({ where: { memberId: id } }),
        this.db.member.delete({ where: { id } }), // memberships and requests go with them (ON DELETE CASCADE); a led department becomes leaderless
      ]);
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false; // already gone
      throw err;
    }
  }
}
