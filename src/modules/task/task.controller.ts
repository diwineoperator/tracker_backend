import type { Request, Response } from 'express';
import { currentMemberId, staffScope } from '../../middleware/auth.middleware';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { AuthClaims } from '../auth/token.service';
import type { TaskService } from './task.service';
import type { CreateTaskBody, ListTasksQuery, TaskIdParams, UpdateMyTaskStatusBody, UpdateTaskBody, UpdateTaskParams } from './task.validation';

/** Thin HTTP adapter for both the admin router (any task) and the member router (own tasks only). */
export class TaskController {
  constructor(private readonly service: TaskService) {}

  // ── member: always scoped to the authenticated member ──
  mine = async (_req: Request, res: Response) => {
    res.json(ok({ tasks: await this.service.listForMember(currentMemberId(res)) }));
  };

  updateMyStatus = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: TaskIdParams; body: UpdateMyTaskStatusBody }>(res);
    res.json(ok({ task: await this.service.updateStatusForMember(currentMemberId(res), params.id, body.status) }));
  };

  startTimer = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TaskIdParams }>(res);
    res.json(ok({ task: await this.service.startTimer(currentMemberId(res), params.id) }));
  };

  discardTimer = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TaskIdParams }>(res);
    res.json(ok({ task: await this.service.discardTimer(currentMemberId(res), params.id) }));
  };

  // ── admin: organisation-wide ──
  list = async (_req: Request, res: Response) => {
    const { query } = validated<{ query: ListTasksQuery }>(res);
    const auth = res.locals['auth'] as AuthClaims;
    res.json(ok({ tasks: await this.service.listAll(staffScope(res), query, auth.username) }));
  };

  create = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: CreateTaskBody }>(res);
    const admin = res.locals['auth'] as AuthClaims;
    res.status(201).json(ok({ task: await this.service.create(staffScope(res), admin.username, body) }));
  };

  update = async (_req: Request, res: Response) => {
    const { params, body } = validated<{ params: UpdateTaskParams; body: UpdateTaskBody }>(res);
    res.json(ok({ task: await this.service.update(staffScope(res), params.id, body) }));
  };

  remove = async (_req: Request, res: Response) => {
    const { params } = validated<{ params: TaskIdParams }>(res);
    await this.service.remove(staffScope(res), params.id);
    res.status(204).end();
  };
}
