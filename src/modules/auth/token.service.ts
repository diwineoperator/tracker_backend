import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Env } from '../../config/env';
import { Errors } from '../../utils/errors';

/** super_admin = the account in the environment; admin = a department's leader (a member row); member. */
export type Role = 'super_admin' | 'admin' | 'member';

export interface AuthClaims {
  role: Role;
  /** Super admin: the fixed string "admin". Admin and member: their member id. */
  subject: string;
  username: string;
}

const ALGORITHM = 'HS256';
export const ADMIN_SUBJECT = 'admin';

/** Signs and verifies JWTs for both account types. Never logs tokens or the secret. */
export class TokenService {
  constructor(private readonly env: Pick<Env, 'JWT_SECRET' | 'JWT_EXPIRES_IN'>) {}

  sign(claims: AuthClaims): { token: string; expiresAt: Date } {
    const token = jwt.sign({ role: claims.role, username: claims.username }, this.env.JWT_SECRET, {
      algorithm: ALGORITHM,
      subject: claims.subject,
      expiresIn: this.env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    });
    const { exp } = jwt.decode(token) as { exp: number };
    return { token, expiresAt: new Date(exp * 1000) };
  }

  verify(token: string): AuthClaims {
    try {
      // Pin the algorithm so a forged `alg: none` / RS256 token is rejected.
      const payload = jwt.verify(token, this.env.JWT_SECRET, { algorithms: [ALGORITHM] });
      if (typeof payload === 'string') throw Errors.tokenInvalid();

      const role = payload['role'];
      const username = payload['username'];
      if ((role !== 'super_admin' && role !== 'admin' && role !== 'member') || !payload.sub || typeof username !== 'string') {
        throw Errors.tokenInvalid();
      }
      // A token issued before roles were split: "admin" with the fixed subject was the super admin.
      if (role === 'admin' && payload.sub === ADMIN_SUBJECT) return { role: 'super_admin', subject: payload.sub, username };
      return { role, subject: payload.sub, username };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw Errors.tokenExpired();
      if (err instanceof jwt.JsonWebTokenError) throw Errors.tokenInvalid();
      throw err;
    }
  }
}
