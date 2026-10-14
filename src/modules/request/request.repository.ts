import type { Database } from '../../config/database';
import type { MessageAuthorRole, RequestFilter, RequestMessageRecord, RequestRecord, RequestStatus } from './request.types';

export interface CreateRequestInput {
  fromMemberId: string;
  toDepartmentId: string;
  subject: string;
  message: string;
}

export interface UpdateRequestInput {
  status?: RequestStatus;
  response?: string | null;
}

export interface CreateMessageInput {
  requestId: string;
  authorRole: MessageAuthorRole;
  authorName: string;
  body: string;
}

export interface RequestRepository {
  /** Newest first. Filters combine (AND). */
  list(filter: RequestFilter): Promise<RequestRecord[]>;
  findById(id: string): Promise<RequestRecord | null>;
  create(input: CreateRequestInput): Promise<RequestRecord>;
  update(id: string, patch: UpdateRequestInput): Promise<RequestRecord | null>;
  /** Oldest first, so a conversation reads top to bottom. */
  listMessagesByRequestIds(requestIds: string[]): Promise<RequestMessageRecord[]>;
  createMessage(input: CreateMessageInput): Promise<RequestMessageRecord>;
}

export class PrismaRequestRepository implements RequestRepository {
  constructor(private readonly db: Database) {}

  async list(filter: RequestFilter) {
    const rows = await this.db.departmentRequest.findMany({
      where: {
        ...(filter.toDepartmentId ? { toDepartmentId: filter.toDepartmentId } : {}),
        ...(filter.fromMemberId ? { fromMemberId: filter.fromMemberId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, status: r.status as RequestStatus }));
  }

  async findById(id: string) {
    const r = await this.db.departmentRequest.findUnique({ where: { id } });
    return r ? { ...r, status: r.status as RequestStatus } : null;
  }

  async create(input: CreateRequestInput) {
    const r = await this.db.departmentRequest.create({ data: input });
    return { ...r, status: r.status as RequestStatus };
  }

  async update(id: string, patch: UpdateRequestInput) {
    const exists = await this.db.departmentRequest.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return null;
    const r = await this.db.departmentRequest.update({ where: { id }, data: patch });
    return { ...r, status: r.status as RequestStatus };
  }

  async listMessagesByRequestIds(requestIds: string[]) {
    if (requestIds.length === 0) return [];
    const rows = await this.db.requestMessage.findMany({ where: { requestId: { in: requestIds } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ ...r, authorRole: r.authorRole as MessageAuthorRole }));
  }

  async createMessage(input: CreateMessageInput) {
    const r = await this.db.requestMessage.create({ data: input });
    return { ...r, authorRole: r.authorRole as MessageAuthorRole };
  }
}
