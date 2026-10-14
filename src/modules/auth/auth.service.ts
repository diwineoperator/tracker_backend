import bcrypt from 'bcryptjs';
import type { Env } from '../../config/env';
import { Errors } from '../../utils/errors';
import type { MemberRepository } from '../member/member.repository';
import { ADMIN_SUBJECT, type Role, type TokenService } from './token.service';

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { role: Role; username: string; fullName: string; departmentIds: string[] };
}

// Compared against when the username does not exist, so the response time does
// not reveal whether an account exists.
const DECOY_HASH = bcrypt.hashSync('decoy-password-for-constant-time', 12);

/** One login for every account type: the super admin (from env), and department leaders and members (from the database). */
export class AuthService {
  private readonly adminUsername: string;
  private readonly adminPasswordHash: string;

  constructor(
    env: Pick<Env, 'ADMIN_USERNAME' | 'ADMIN_PASSWORD_HASH'>,
    private readonly tokens: TokenService,
    private readonly members: Pick<MemberRepository, 'findByUsername'>,
  ) {
    this.adminUsername = env.ADMIN_USERNAME.trim().toLowerCase();
    this.adminPasswordHash = env.ADMIN_PASSWORD_HASH;
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const name = username.trim().toLowerCase();

    if (name === this.adminUsername) {
      if (!(await bcrypt.compare(password, this.adminPasswordHash))) throw Errors.invalidCredentials();
      return this.issue('super_admin', ADMIN_SUBJECT, this.adminUsername, this.adminUsername, []);
    }

    const member = await this.members.findByUsername(name);
    const passwordMatches = await bcrypt.compare(password, member?.passwordHash ?? DECOY_HASH);
    if (!member || !passwordMatches) throw Errors.invalidCredentials();
    // Only revealed after the password is proven correct.
    if (!member.isActive) throw Errors.accountDisabled();

    // A department leader signs in the same way; the role only says which screens and data they get.
    return this.issue(member.role === 'ADMIN' ? 'admin' : 'member', member.id, member.username, member.fullName, member.departmentIds);
  }

  private issue(role: Role, subject: string, username: string, fullName: string, departmentIds: string[]): LoginResult {
    const { token, expiresAt } = this.tokens.sign({ role, subject, username });
    return { token, expiresAt: expiresAt.toISOString(), user: { role, username, fullName, departmentIds } };
  }
}
