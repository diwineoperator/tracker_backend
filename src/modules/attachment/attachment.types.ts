export const ATTACHMENT_KINDS = ['REQUEST', 'REPLY'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type UploaderRole = 'member' | 'admin' | 'super_admin';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Per request, per side (what the member sent / what the leader replied with). */
export const MAX_ATTACHMENTS_PER_KIND = 5;

/** Persistence-level shape. The bytes are elsewhere (the file store), under `storageKey`. */
export interface AttachmentRecord {
  id: string;
  requestId: string;
  kind: AttachmentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  uploadedByRole: UploaderRole;
  createdAt: Date;
}

/** What the API shows about a file — never the storage key or path. */
export interface AttachmentDto {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}
