import { randomUUID } from 'node:crypto';
import type { AttachmentRepository, CreateAttachmentInput } from '../../src/modules/attachment/attachment.repository';
import type { FileStorage } from '../../src/modules/attachment/file-storage';
import type { AttachmentKind, AttachmentRecord } from '../../src/modules/attachment/attachment.types';

export class InMemoryAttachmentRepository implements AttachmentRepository {
  readonly rows: AttachmentRecord[] = [];

  async listByRequestIds(requestIds: string[]) {
    return this.rows.filter((a) => requestIds.includes(a.requestId)).map((a) => ({ ...a }));
  }
  async findById(id: string) {
    const row = this.rows.find((a) => a.id === id);
    return row ? { ...row } : null;
  }
  async count(requestId: string, kind: AttachmentKind) {
    return this.rows.filter((a) => a.requestId === requestId && a.kind === kind).length;
  }
  async create(input: CreateAttachmentInput) {
    const row: AttachmentRecord = { id: randomUUID(), ...input, createdAt: new Date() };
    this.rows.push(row);
    return { ...row };
  }
  async remove(id: string) {
    const i = this.rows.findIndex((a) => a.id === id);
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
}

export class InMemoryFileStorage implements FileStorage {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}
