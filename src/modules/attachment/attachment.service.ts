import { randomUUID } from 'node:crypto';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { inScope, type StaffScope } from '../../utils/scope';
import type { RequestRepository } from '../request/request.repository';
import type { RequestRecord } from '../request/request.types';
import { checkUpload, INLINE_TYPES } from './attachment.rules';
import type { AttachmentRepository } from './attachment.repository';
import type { FileStorage } from './file-storage';
import { MAX_ATTACHMENTS_PER_KIND, type AttachmentDto, type AttachmentKind, type AttachmentRecord, type UploaderRole } from './attachment.types';

export const toAttachmentDto = (a: AttachmentRecord): AttachmentDto => ({
  id: a.id,
  kind: a.kind,
  fileName: a.fileName,
  contentType: a.contentType,
  sizeBytes: a.sizeBytes,
  uploadedBy: a.uploadedBy,
  createdAt: a.createdAt.toISOString(),
});

export interface UploadInput {
  fileName: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

export interface OpenedFile {
  fileName: string;
  contentType: string;
  data: Buffer;
  /** Only safe image types are shown inline; everything else is forced to download. */
  inline: boolean;
}

/**
 * Files on requests. Access is exactly the request's own: a member touches only their own requests' files (and
 * only the ones they sent), a leader only requests addressed to their department (and only the replies they
 * attach), the super admin every request. Anything else is "not found" — never confirmed to exist.
 */
export class AttachmentService {
  constructor(
    private readonly attachments: AttachmentRepository,
    private readonly requests: Pick<RequestRepository, 'findById'>,
    private readonly storage: FileStorage,
  ) {}

  // ── member: their own requests, the REQUEST side ──
  async uploadForMember(memberId: string, username: string, requestId: string, input: UploadInput): Promise<AttachmentDto> {
    const request = await this.ownRequest(memberId, requestId);
    this.requireOpen(request);
    return this.store(request.id, 'REQUEST', 'member', username, input);
  }

  async removeForMember(memberId: string, requestId: string, attachmentId: string): Promise<void> {
    const request = await this.ownRequest(memberId, requestId);
    const attachment = await this.requireOn(requestId, attachmentId);
    if (attachment.kind !== 'REQUEST') throw Errors.forbidden();
    this.requireOpen(request);
    await this.discard(attachment);
  }

  async openForMember(memberId: string, requestId: string, attachmentId: string, forceDownload: boolean): Promise<OpenedFile> {
    await this.ownRequest(memberId, requestId);
    return this.read(await this.requireOn(requestId, attachmentId), forceDownload);
  }

  // ── staff: requests in their scope, the REPLY side ──
  async uploadForStaff(scope: StaffScope, role: 'admin' | 'super_admin', username: string, requestId: string, input: UploadInput): Promise<AttachmentDto> {
    const request = await this.scopedRequest(scope, requestId);
    return this.store(request.id, 'REPLY', role satisfies UploaderRole, username, input);
  }

  async removeForStaff(scope: StaffScope, requestId: string, attachmentId: string): Promise<void> {
    await this.scopedRequest(scope, requestId);
    const attachment = await this.requireOn(requestId, attachmentId);
    if (attachment.kind !== 'REPLY') throw Errors.forbidden();
    await this.discard(attachment);
  }

  async openForStaff(scope: StaffScope, requestId: string, attachmentId: string, forceDownload: boolean): Promise<OpenedFile> {
    await this.scopedRequest(scope, requestId);
    return this.read(await this.requireOn(requestId, attachmentId), forceDownload);
  }

  // ── internals ──
  private async ownRequest(memberId: string, requestId: string): Promise<RequestRecord> {
    const request = await this.requests.findById(requestId);
    if (!request || request.fromMemberId !== memberId) throw Errors.requestNotFound();
    return request;
  }

  private async scopedRequest(scope: StaffScope, requestId: string): Promise<RequestRecord> {
    const request = await this.requests.findById(requestId);
    if (!request || !inScope(scope, request.toDepartmentId)) throw Errors.requestNotFound();
    return request;
  }

  /** A sender can change their files only while the request is still being handled. */
  private requireOpen(request: RequestRecord) {
    if (request.status === 'DONE' || request.status === 'DECLINED') throw Errors.requestClosedForAttachments();
  }

  private async requireOn(requestId: string, attachmentId: string): Promise<AttachmentRecord> {
    const attachment = await this.attachments.findById(attachmentId);
    if (!attachment || attachment.requestId !== requestId) throw Errors.attachmentNotFound();
    return attachment;
  }

  private async store(requestId: string, kind: AttachmentKind, role: UploaderRole, username: string, input: UploadInput): Promise<AttachmentDto> {
    const file = checkUpload(input);
    if ((await this.attachments.count(requestId, kind)) >= MAX_ATTACHMENTS_PER_KIND) throw Errors.tooManyAttachments(MAX_ATTACHMENTS_PER_KIND);

    const storageKey = `${requestId}/${randomUUID()}`;
    await this.storage.put(storageKey, input.body as Buffer);
    try {
      const created = await this.attachments.create({ requestId, kind, ...file, storageKey, uploadedBy: username, uploadedByRole: role });
      return toAttachmentDto(created);
    } catch (err) {
      await this.storage.remove(storageKey).catch(() => undefined); // never leave bytes without a row
      throw err;
    }
  }

  private async discard(attachment: AttachmentRecord) {
    await this.attachments.remove(attachment.id);
    // The row is the source of truth; a leftover file is harmless, so a failed delete is logged, not surfaced.
    await this.storage.remove(attachment.storageKey).catch((err) => logger.error('Could not delete attachment file', err, { attachmentId: attachment.id }));
  }

  private async read(attachment: AttachmentRecord, forceDownload: boolean): Promise<OpenedFile> {
    const data = await this.storage.get(attachment.storageKey);
    if (!data) throw Errors.attachmentNotFound();
    return { fileName: attachment.fileName, contentType: attachment.contentType, data, inline: !forceDownload && INLINE_TYPES.has(attachment.contentType) };
  }
}
