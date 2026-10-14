import type { Request, Response } from 'express';
import { currentMemberId, staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { TimeTrackerService } from './time-tracker.service';
import type {
  ActivityHistoryQuery,
  CreateTrackerBody,
  MemberActivityHistoryQuery,
  MemberIdParams,
  TrackerIdParams,
  UpdateTrackerBody,
  UpdateTrackerParams,
} from './time-tracker.validation';

/** Thin HTTP adapter for both the member router (own ledger) and the admin router (any ledger). */
export class TimeTrackerController {
  constructor(private readonly service: TimeTrackerService) {}

  // ── member: always scoped to the authenticated member ──
  create = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: CreateTrackerBody }>(res);
    res.status(201).json(ok(await this.service.create(currentMemberId(res), body)));
  };

  today = async (_req: Request, res: Response) => {
    res.json(ok(await this.service.today(currentMemberId(res))));
  };

  closeDay = async (_req: Request, res: Response) => {
    res.json(ok(await this.service.closeDay(currentMemberId(res))));
  };

  getOne = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TrackerIdParams }>(res);
    res.json(ok(await this.service.get({ role: 'member', memberId: currentMemberId(res) }, params.id)));
  };

  update = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateTrackerParams; body: UpdateTrackerBody }>(res);
    res.json(ok(await this.service.update({ role: 'member', memberId: currentMemberId(res) }, params.id, body)));
  };

  remove = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TrackerIdParams }>(res);
    res.json(ok(await this.service.remove({ role: 'member', memberId: currentMemberId(res) }, params.id)));
  };

  /** The member's own history only — `memberId` always comes from the JWT
   * (`currentMemberId`), never from the query (the schema has no such field). */
  memberActivityHistory = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: MemberActivityHistoryQuery }>(res);
    res.json(ok(await this.service.activityHistory({ kind: 'all' }, { ...query, memberId: currentMemberId(res) })));
  };

  // ── admin: any member's entries ──
  overview = async (_req: Request, res: Response) => {
    res.json(ok({ members: await this.service.overview(staffScope(res)) }));
  };

  todayForMember = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: MemberIdParams }>(res);
    res.json(ok(await this.service.todayForMember(staffScope(res), params.memberId)));
  };

  adminGetOne = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TrackerIdParams }>(res);
    res.json(ok(await this.service.get({ role: 'admin', scope: staffScope(res) }, params.id)));
  };

  adminUpdate = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateTrackerParams; body: UpdateTrackerBody }>(res);
    res.json(ok(await this.service.update({ role: 'admin', scope: staffScope(res) }, params.id, body)));
  };

  adminRemove = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TrackerIdParams }>(res);
    res.json(ok(await this.service.remove({ role: 'admin', scope: staffScope(res) }, params.id)));
  };

  activityHistory = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: ActivityHistoryQuery }>(res);
    res.json(ok(await this.service.activityHistory(staffScope(res), query)));
  };
}
