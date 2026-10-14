import type { Request, Response } from 'express';
import { currentMemberId, staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { BadgeService } from './badge.service';
import type { MemberBadgesQuery, StaffBadgesQuery } from './badge.validation';

export class BadgeController {
  constructor(private readonly service: BadgeService) {}

  /** Always the authenticated member — there is no id to pass. */
  member = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: MemberBadgesQuery }>(res);
    const date = (v?: string) => (v ? new Date(v) : undefined);
    res.json(ok(await this.service.forMember(currentMemberId(res), { requests: date(query.requestsSince), tasks: date(query.tasksSince) })));
  };

  staff = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: StaffBadgesQuery }>(res);
    res.json(ok(await this.service.forStaff(staffScope(res), query.tasksSince ? new Date(query.tasksSince) : undefined)));
  };
}
