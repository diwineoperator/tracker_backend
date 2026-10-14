import type { Request, Response } from 'express';
import { validated } from '../../middleware/validation.middleware';
import { ok } from '../../utils/api-response';
import type { AuthService } from './auth.service';
import type { LoginBody } from './auth.validation';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  login = async (_req: Request, res: Response) => {
    const { body } = validated<{ body: LoginBody }>(res);
    const result = await this.authService.login(body.username, body.password);
    res.json(ok(result));
  };
}
