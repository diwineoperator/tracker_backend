import { Router } from 'express';
import type { Request, Response } from 'express';
import { currentMemberId } from '../../middleware/auth.middleware';
import { ok } from '../../utils/api-response';
import type { TeamService } from './team.service';

/** Mounted behind authenticate + requireMember: the caller's own department only — the id comes from the session. */
export function createTeamRouter(service: TeamService): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response) => {
    res.json(ok(await service.forMember(currentMemberId(res))));
  });
  return router;
}
