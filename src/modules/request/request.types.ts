export const REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'DECLINED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

import type { AttachmentDto } from '../attachment/attachment.types';

/** Persistence-level shape. */
export interface RequestRecord {
  id: string;
  fromMemberId: string;
  toDepartmentId: string;
  subject: string;
  message: string;
  status: RequestStatus;
  response: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestFilter {
  toDepartmentId?: string;
  fromMemberId?: string;
  status?: RequestStatus;
}

export type MessageAuthorRole = 'member' | 'admin' | 'super_admin';

/** Persistence-level shape. Immutable — never edited or deleted, only appended to. */
export interface RequestMessageRecord {
  id: string;
  requestId: string;
  authorRole: MessageAuthorRole;
  authorName: string;
  body: string;
  createdAt: Date;
}

/** One entry in a request's conversation, after the original ask and the first reply. */
export interface RequestMessageDto {
  id: string;
  authorRole: MessageAuthorRole;
  authorName: string;
  body: string;
  createdAt: string;
}

/** What a receiving leader / the super admin sees: who asked, from which department. */
export interface InboxRequestDto {
  id: string;
  subject: string;
  message: string;
  status: RequestStatus;
  response: string | null;
  fromMemberId: string;
  fromMemberName: string;
  /** The sender's department(s) — a member can belong to two. */
  fromDepartments: { id: string; name: string }[];
  toDepartmentId: string;
  toDepartmentName: string;
  attachments: AttachmentDto[];
  messages: RequestMessageDto[];
  createdAt: string;
  updatedAt: string;
}

/** What the sender sees about their own request. */
export interface MyRequestDto {
  id: string;
  subject: string;
  message: string;
  status: RequestStatus;
  response: string | null;
  toDepartmentId: string;
  toDepartmentName: string;
  toLeaderName: string | null;
  attachments: AttachmentDto[];
  messages: RequestMessageDto[];
  createdAt: string;
  updatedAt: string;
}

/** A department a member may send a request to. */
export interface RequestTargetDto {
  departmentId: string;
  departmentName: string;
  leaderName: string;
  /** True for a department the member belongs to — its leader can be asked too. */
  isOwnDepartment: boolean;
}
