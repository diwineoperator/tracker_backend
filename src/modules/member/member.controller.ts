import type { Request, Response } from 'express';
import { staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { MemberService } from './member.service';
import type { CreateMemberBody, MemberIdParams, UpdateMemberBody, UpdateMemberParams } from './member.validation';

export class MemberController {
  constructor(private readonly service: MemberService) {}

  list = async (_req: Request, res: Response) => {
    res.json(ok({ members: await this.service.list(staffScope(res)) }));
  };

  create = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: CreateMemberBody }>(res);
    res.status(201).json(ok({ member: await this.service.create(staffScope(res), body) }));
  };

  update = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateMemberParams; body: UpdateMemberBody }>(res);
    res.json(ok({ member: await this.service.update(staffScope(res), params.id, body) }));
  };

  impact = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: MemberIdParams }>(res);
    res.json(ok({ impact: await this.service.impact(staffScope(res), params.id) }));
  };

  remove = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: MemberIdParams }>(res);
    await this.service.remove(staffScope(res), params.id);
    res.status(204).end();
  };
}
