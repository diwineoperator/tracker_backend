import type { Request, Response } from 'express';
import { staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { DepartmentService } from './department.service';
import type { AssignLeaderBody, CreateDepartmentBody, DepartmentIdParams, UpdateDepartmentBody, UpdateDepartmentParams } from './department.validation';

export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  list = async (_req: Request, res: Response) => {
    res.json(ok({ departments: await this.service.list(staffScope(res)) }));
  };

  /** Every OTHER department with a leader — narrow, cross-department info any staff caller may see, to hand a task to one. */
  leaderTargets = async (_req: Request, res: Response) => {
    res.json(ok({ departments: await this.service.leaderTargets(staffScope(res)) }));
  };

  create = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: CreateDepartmentBody }>(res);
    res.status(201).json(ok({ department: await this.service.create(body) }));
  };

  assignLeader = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: DepartmentIdParams; body: AssignLeaderBody }>(res);
    res.json(ok({ department: await this.service.assignLeader(params.id, body.memberId) }));
  };

  removeLeader = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: DepartmentIdParams }>(res);
    res.json(ok({ department: await this.service.removeLeader(params.id) }));
  };

  update = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateDepartmentParams; body: UpdateDepartmentBody }>(res);
    res.json(ok({ department: await this.service.update(params.id, body) }));
  };

  impact = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: DepartmentIdParams }>(res);
    res.json(ok({ impact: await this.service.impact(params.id) }));
  };

  remove = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: DepartmentIdParams }>(res);
    await this.service.remove(params.id);
    res.status(204).end();
  };
}
