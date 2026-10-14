import { Errors } from '../../utils/errors';
import { inScope, scopedDepartmentId, type StaffScope } from '../../utils/scope';
import type { DepartmentRepository } from '../department/department.repository';
import type { MemberRepository } from '../member/member.repository';
import type { AttachmentRepository } from '../attachment/attachment.repository';
import { toAttachmentDto } from '../attachment/attachment.service';
import type { RequestRepository } from './request.repository';
import type { InboxRequestDto, MessageAuthorRole, MyRequestDto, RequestMessageRecord, RequestRecord, RequestTargetDto } from './request.types';
import type { ListInboxQuery, SendRequestBody, UpdateRequestBody } from './request.validation';

/**
 * A member asks ANOTHER department's leader for something; the leader (or the super admin)
 * reads it, changes its status and replies. The receiving department is fixed by the caller's
 * scope on the inbox side, and the sender is always the authenticated member — nothing about
 * who is asking or which inbox is read comes from the request.
 */
export class RequestService {
  constructor(
    private readonly repo: RequestRepository,
    private readonly members: Pick<MemberRepository, 'list' | 'findById' | 'findLeader'>,
    private readonly departments: Pick<DepartmentRepository, 'list' | 'findById'>,
    private readonly attachments: Pick<AttachmentRepository, 'listByRequestIds'>,
  ) {}

  /**
   * Every department that can receive a request: active, with an enabled leader. A member may ask the leader of
   * a department they belong to as well as any other's; their own departments are listed first.
   */
  async targets(memberId: string): Promise<RequestTargetDto[]> {
    const me = await this.members.findById(memberId);
    const [departments, members] = await Promise.all([this.departments.list(), this.members.list()]);
    return departments
      .filter((d) => d.isActive)
      .flatMap((d) => {
        const leader = members.find((m) => m.id === d.leaderId && m.role === 'ADMIN' && m.isActive);
        return leader ? [{ departmentId: d.id, departmentName: d.name, leaderName: leader.fullName, isOwnDepartment: !!me?.departmentIds.includes(d.id) }] : [];
      })
      .sort((a, b) => Number(b.isOwnDepartment) - Number(a.isOwnDepartment) || a.departmentName.localeCompare(b.departmentName));
  }

  async send(memberId: string, input: SendRequestBody): Promise<MyRequestDto> {
    const me = await this.members.findById(memberId);
    if (!me) throw Errors.memberNotFound();
    const department = await this.departments.findById(input.toDepartmentId);
    if (!department) throw Errors.departmentNotFound();
    if (!department.isActive) throw Errors.departmentInactive();
    const leader = await this.members.findLeader(input.toDepartmentId);
    if (!leader || !leader.isActive) throw Errors.departmentNoLeader();

    const created = await this.repo.create({ fromMemberId: memberId, toDepartmentId: input.toDepartmentId, subject: input.subject, message: input.message });
    return (await this.toMine([created]))[0]!;
  }

  /** The caller's own requests — the id comes from the session. */
  async listMine(memberId: string): Promise<MyRequestDto[]> {
    return this.toMine(await this.repo.list({ fromMemberId: memberId }));
  }

  /** Requests addressed to the caller's department (the super admin: every request). */
  async inbox(scope: StaffScope, query: ListInboxQuery): Promise<InboxRequestDto[]> {
    const own = scopedDepartmentId(scope);
    return this.toInbox(await this.repo.list({ ...(own && { toDepartmentId: own }), ...(query.status && { status: query.status }) }));
  }

  async update(scope: StaffScope, id: string, input: UpdateRequestBody): Promise<InboxRequestDto> {
    const existing = await this.repo.findById(id);
    // Someone else's inbox is "not found" — never confirmed to exist.
    if (!existing || !inScope(scope, existing.toDepartmentId)) throw Errors.requestNotFound();
    const updated = await this.repo.update(id, {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.response !== undefined && { response: input.response }),
    });
    if (!updated) throw Errors.requestNotFound();
    return (await this.toInbox([updated]))[0]!;
  }

  /**
   * A follow-up message from the sender, continuing the conversation after the original ask
   * (and, usually, the leader's first reply). Blocked once the request is closed — same rule as
   * the sender's own attachments, and for the same reason: it's no longer being worked.
   */
  async sendMemberMessage(memberId: string, id: string, body: string): Promise<MyRequestDto> {
    const request = await this.repo.findById(id);
    if (!request || request.fromMemberId !== memberId) throw Errors.requestNotFound();
    if (request.status === 'DONE' || request.status === 'DECLINED') throw Errors.requestClosedForReplies();
    const me = await this.members.findById(memberId);
    await this.repo.createMessage({ requestId: id, authorRole: 'member', authorName: me?.fullName ?? 'Member', body });
    return (await this.toMine([request]))[0]!;
  }

  /**
   * A follow-up message from the receiving leader (or the super admin). Unlike the sender's own,
   * this is never blocked by a closed status — staff can always add a final note, same as they
   * can always still attach a file to their reply.
   */
  async sendStaffMessage(scope: StaffScope, role: 'admin' | 'super_admin', actorId: string, id: string, body: string): Promise<InboxRequestDto> {
    const request = await this.repo.findById(id);
    if (!request || !inScope(scope, request.toDepartmentId)) throw Errors.requestNotFound();
    const authorName = role === 'super_admin' ? 'Super Admin' : ((await this.members.findById(actorId))?.fullName ?? 'Leader');
    await this.repo.createMessage({ requestId: id, authorRole: role, authorName, body });
    return (await this.toInbox([request]))[0]!;
  }

  /** The files on these requests (one query), grouped by request. */
  private async filesOf(records: RequestRecord[]) {
    const byRequest = new Map<string, ReturnType<typeof toAttachmentDto>[]>();
    for (const a of await this.attachments.listByRequestIds(records.map((r) => r.id))) byRequest.set(a.requestId, [...(byRequest.get(a.requestId) ?? []), toAttachmentDto(a)]);
    return byRequest;
  }

  /** The conversation on these requests (one query), grouped by request, oldest first. */
  private async messagesOf(records: RequestRecord[]) {
    const byRequest = new Map<string, RequestMessageRecord[]>();
    for (const m of await this.repo.listMessagesByRequestIds(records.map((r) => r.id))) byRequest.set(m.requestId, [...(byRequest.get(m.requestId) ?? []), m]);
    const toDto = (m: RequestMessageRecord) => ({ id: m.id, authorRole: m.authorRole as MessageAuthorRole, authorName: m.authorName, body: m.body, createdAt: m.createdAt.toISOString() });
    return new Map([...byRequest].map(([requestId, rows]) => [requestId, rows.map(toDto)]));
  }

  private async toMine(records: RequestRecord[]): Promise<MyRequestDto[]> {
    const [departments, members, files, messages] = await Promise.all([this.departments.list(), this.members.list(), this.filesOf(records), this.messagesOf(records)]);
    const nameOf = new Map(departments.map((d) => [d.id, d.name]));
    const leaderOf = new Map(departments.map((d) => [d.id, d.leaderId]));
    return records.map((r) => ({
      id: r.id,
      subject: r.subject,
      message: r.message,
      status: r.status,
      response: r.response,
      toDepartmentId: r.toDepartmentId,
      toDepartmentName: nameOf.get(r.toDepartmentId) ?? 'Unknown department',
      toLeaderName: members.find((m) => m.id === leaderOf.get(r.toDepartmentId))?.fullName ?? null,
      attachments: files.get(r.id) ?? [],
      messages: messages.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  private async toInbox(records: RequestRecord[]): Promise<InboxRequestDto[]> {
    const [departments, members, files, messages] = await Promise.all([this.departments.list(), this.members.list(), this.filesOf(records), this.messagesOf(records)]);
    const nameOf = new Map(departments.map((d) => [d.id, d.name]));
    const memberOf = new Map(members.map((m) => [m.id, m]));
    return records.map((r) => {
      const from = memberOf.get(r.fromMemberId);
      return {
        id: r.id,
        subject: r.subject,
        message: r.message,
        status: r.status,
        response: r.response,
        fromMemberId: r.fromMemberId,
        fromMemberName: from?.fullName ?? 'Unknown member',
        fromDepartments: (from?.departmentIds ?? []).flatMap((id) => (nameOf.has(id) ? [{ id, name: nameOf.get(id)! }] : [])),
        toDepartmentId: r.toDepartmentId,
        toDepartmentName: nameOf.get(r.toDepartmentId) ?? 'Unknown department',
        attachments: files.get(r.id) ?? [],
        messages: messages.get(r.id) ?? [],
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}
