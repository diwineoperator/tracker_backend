import type { Request, Response } from 'express';
import { currentMemberId, staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { AuthClaims } from '../auth/token.service';
import type { RequestService } from './request.service';
import type { ListInboxQuery, SendMessageBody, SendMessageParams, SendRequestBody, UpdateRequestBody, UpdateRequestParams } from './request.validation';

export class RequestController {
  constructor(private readonly service: RequestService) {}

  // ── member: always the authenticated member ──
  targets = async (_req: Request, res: Response) => {
    res.json(ok({ targets: await this.service.targets(currentMemberId(res)) }));
  };

  mine = async (_req: Request, res: Response) => {
    res.json(ok({ requests: await this.service.listMine(currentMemberId(res)) }));
  };

  send = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: SendRequestBody }>(res);
    res.status(201).json(ok({ request: await this.service.send(currentMemberId(res), body) }));
  };

  sendMemberMessage = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: SendMessageParams; body: SendMessageBody }>(res);
    res.status(201).json(ok({ request: await this.service.sendMemberMessage(currentMemberId(res), params.id, body.body) }));
  };

  // ── admin side: limited by the caller's scope ──
  inbox = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: ListInboxQuery }>(res);
    res.json(ok({ requests: await this.service.inbox(staffScope(res), query) }));
  };

  update = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateRequestParams; body: UpdateRequestBody }>(res);
    res.json(ok({ request: await this.service.update(staffScope(res), params.id, body) }));
  };

  sendStaffMessage = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: SendMessageParams; body: SendMessageBody }>(res);
    const auth = res.locals['auth'] as AuthClaims;
    const role = auth.role === 'super_admin' ? 'super_admin' : 'admin';
    res.status(201).json(ok({ request: await this.service.sendStaffMessage(staffScope(res), role, auth.subject, params.id, body.body) }));
  };
}
