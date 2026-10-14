import type { RequestHandler, Response } from 'express';
import type { AuthClaims, TokenService } from '../modules/auth/token.service';
import type { MemberRepository } from '../modules/member/member.repository';
import { Errors } from '../utils/errors';
import type { StaffScope } from '../utils/scope';

/** Step 1 — any valid `Authorization: Bearer <jwt>` (super admin, admin or member). */
export const authenticate =
  (tokens: TokenService): RequestHandler =>
  (req, res, next) => {
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw Errors.authRequired();
    res.locals['auth'] = tokens.verify(token);
    next();
  };

/** Step 2a — super-admin-only routes (departments, leaders). Everyone else's valid token is rejected with 403. */
export const requireSuperAdmin: RequestHandler = (_req, res, next) => {
  if ((res.locals['auth'] as AuthClaims | undefined)?.role !== 'super_admin') throw Errors.forbidden();
  next();
};

/**
 * Step 2a' — the admin side: the super admin, or a department's leader. A leader is
 * re-checked in the database on every request (still exists, still enabled, still
 * ADMIN of a department), so demoting or disabling them takes effect at once. The
 * result is a `StaffScope` that every admin-side service uses to limit what it reads
 * and writes — the scope always comes from here, never from the request.
 */
export const requireStaff =
  (members: Pick<MemberRepository, 'findById'>): RequestHandler =>
  async (_req, res, next) => {
    const auth = res.locals['auth'] as AuthClaims | undefined;
    if (auth?.role === 'super_admin') {
      res.locals['scope'] = { kind: 'all' } satisfies StaffScope;
      return next();
    }
    if (auth?.role !== 'admin') throw Errors.forbidden();

    const leader = await members.findById(auth.subject);
    if (!leader) throw Errors.tokenInvalid();
    if (!leader.isActive) throw Errors.accountDisabled();
    // A leader's `departmentIds` is the one department they lead; an Admin who leads none has no scope at all.
    const [led] = leader.departmentIds;
    if (leader.role !== 'ADMIN' || !led) throw Errors.forbidden();
    res.locals['scope'] = { kind: 'department', departmentId: led, adminId: leader.id } satisfies StaffScope;
    next();
  };

/** The admin-side caller's scope. Only valid behind `requireStaff`. */
export const staffScope = (res: Response): StaffScope => res.locals['scope'] as StaffScope;

/**
 * Step 2b — member-only routes. Also re-checks the member in the database on
 * every request, so disabling a member takes effect immediately instead of
 * when their JWT happens to expire.
 */
export const requireMember =
  (members: Pick<MemberRepository, 'findById'>): RequestHandler =>
  async (_req, res, next) => {
    const auth = res.locals['auth'] as AuthClaims | undefined;
    if (auth?.role !== 'member') throw Errors.forbidden();

    const member = await members.findById(auth.subject);
    if (!member) throw Errors.tokenInvalid(); // account no longer exists
    if (!member.isActive) throw Errors.accountDisabled();
    if (member.role !== 'MEMBER') throw Errors.forbidden(); // promoted to leader since this token was issued

    res.locals['memberId'] = member.id;
    next();
  };

/** The authenticated member's id. Only valid behind `requireMember` or `requireWorker`. */
export const currentMemberId = (res: Response): string => res.locals['memberId'] as string;

/**
 * Step 2b' — a MEMBER, or a department's leader (ADMIN) acting on their OWN work: task
 * self-service and the Time Tracker/Ledger. A leader's own directly-assigned tasks are just rows
 * in the same `tasks`/`time_tracker` tables keyed by their member id, so this reuses every one of
 * those services exactly as a member's does — nothing about the Time Tracker/Ledger logic changes,
 * and it grants nothing else: `/api/team`, `/api/requests` and `/api/badges` stay `requireMember`
 * (member-only), and a leader's admin-side powers (`requireStaff`) are untouched either way.
 */
export const requireWorker =
  (members: Pick<MemberRepository, 'findById'>): RequestHandler =>
  async (_req, res, next) => {
    const auth = res.locals['auth'] as AuthClaims | undefined;
    if (auth?.role !== 'member' && auth?.role !== 'admin') throw Errors.forbidden();

    const account = await members.findById(auth.subject);
    if (!account) throw Errors.tokenInvalid(); // account no longer exists
    if (!account.isActive) throw Errors.accountDisabled();
    // A member promoted to leader (or the reverse) since this token was issued still only reaches
    // the role their account has right now — never both at once.
    if (account.role === 'MEMBER' && auth.role !== 'member') throw Errors.forbidden();
    if (account.role === 'ADMIN' && auth.role !== 'admin') throw Errors.forbidden();

    res.locals['memberId'] = account.id;
    next();
  };
