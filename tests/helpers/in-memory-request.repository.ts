import { randomUUID } from 'node:crypto';
import type { CreateMessageInput, CreateRequestInput, RequestRepository, UpdateRequestInput } from '../../src/modules/request/request.repository';
import type { RequestFilter, RequestMessageRecord, RequestRecord } from '../../src/modules/request/request.types';

/** Behaves like the Prisma repository (newest first, AND-combined filters). */
export class InMemoryRequestRepository implements RequestRepository {
  readonly rows: RequestRecord[] = [];
  readonly messageRows: RequestMessageRecord[] = [];

  async list(filter: RequestFilter) {
    return this.rows
      .filter(
        (r) =>
          (!filter.toDepartmentId || r.toDepartmentId === filter.toDepartmentId) &&
          (!filter.fromMemberId || r.fromMemberId === filter.fromMemberId) &&
          (!filter.status || r.status === filter.status),
      )
      .map((r) => ({ ...r }))
      .reverse();
  }

  async findById(id: string) {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async create(input: CreateRequestInput) {
    const now = new Date();
    const row: RequestRecord = { id: randomUUID(), ...input, status: 'OPEN', response: null, createdAt: now, updatedAt: now };
    this.rows.push(row);
    return { ...row };
  }

  async update(id: string, patch: UpdateRequestInput) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date() });
    return { ...row };
  }

  async listMessagesByRequestIds(requestIds: string[]) {
    return this.messageRows.filter((m) => requestIds.includes(m.requestId)).map((m) => ({ ...m }));
  }

  async createMessage(input: CreateMessageInput) {
    const row: RequestMessageRecord = { id: randomUUID(), ...input, createdAt: new Date() };
    this.messageRows.push(row);
    return { ...row };
  }

  private removeMessagesFor(requestIds: string[]) {
    for (let i = this.messageRows.length - 1; i >= 0; i--) if (requestIds.includes(this.messageRows[i]!.requestId)) this.messageRows.splice(i, 1);
  }

  /** Like the database's ON DELETE CASCADE: a request (and its messages) goes with its sender or its receiving department. */
  removeForMember(memberId: string) {
    const gone = this.rows.filter((r) => r.fromMemberId === memberId).map((r) => r.id);
    this.removeMessagesFor(gone);
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.fromMemberId === memberId) this.rows.splice(i, 1);
  }
  removeForDepartment(departmentId: string) {
    const gone = this.rows.filter((r) => r.toDepartmentId === departmentId).map((r) => r.id);
    this.removeMessagesFor(gone);
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.toDepartmentId === departmentId) this.rows.splice(i, 1);
  }
}
