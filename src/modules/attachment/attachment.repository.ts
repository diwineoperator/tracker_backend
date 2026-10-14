import type { Database } from '../../config/database';
import type { AttachmentKind, AttachmentRecord, UploaderRole } from './attachment.types';

export interface CreateAttachmentInput {
  requestId: string;
  kind: AttachmentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  uploadedByRole: UploaderRole;
}

export interface AttachmentRepository {
  /** Oldest first, so files show in the order they were added. */
  listByRequestIds(requestIds: string[]): Promise<AttachmentRecord[]>;
  findById(id: string): Promise<AttachmentRecord | null>;
  count(requestId: string, kind: AttachmentKind): Promise<number>;
  create(input: CreateAttachmentInput): Promise<AttachmentRecord>;
  /** Returns false if it does not exist. */
  remove(id: string): Promise<boolean>;
}

const toRecord = (r: { uploadedByRole: string; kind: string } & Omit<AttachmentRecord, 'uploadedByRole' | 'kind'>): AttachmentRecord => ({
  ...r,
  kind: r.kind as AttachmentKind,
  uploadedByRole: r.uploadedByRole as UploaderRole,
});

export class PrismaAttachmentRepository implements AttachmentRepository {
  constructor(private readonly db: Database) {}

  async listByRequestIds(requestIds: string[]) {
    if (requestIds.length === 0) return [];
    const rows = await this.db.requestAttachment.findMany({ where: { requestId: { in: requestIds } }, orderBy: { createdAt: 'asc' } });
    return rows.map(toRecord);
  }

  async findById(id: string) {
    const row = await this.db.requestAttachment.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  count(requestId: string, kind: AttachmentKind) {
    return this.db.requestAttachment.count({ where: { requestId, kind } });
  }

  async create(input: CreateAttachmentInput) {
    return toRecord(await this.db.requestAttachment.create({ data: input }));
  }

  async remove(id: string) {
    const { count } = await this.db.requestAttachment.deleteMany({ where: { id } });
    return count > 0;
  }
}
