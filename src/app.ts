import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { authenticate, requireMember, requireStaff, requireWorker } from './middleware/auth.middleware';
import { AuthController } from './modules/auth/auth.controller';
import { createAuthRouter } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { BadgeController } from './modules/badge/badge.controller';
import { AttachmentController } from './modules/attachment/attachment.controller';
import type { AttachmentRepository } from './modules/attachment/attachment.repository';
import { AttachmentService } from './modules/attachment/attachment.service';
import type { FileStorage } from './modules/attachment/file-storage';
import { createMemberBadgeRouter, createStaffBadgeRouter } from './modules/badge/badge.routes';
import { BadgeService } from './modules/badge/badge.service';
import { RequestController } from './modules/request/request.controller';
import type { RequestRepository } from './modules/request/request.repository';
import { createMemberRequestRouter, createStaffRequestRouter } from './modules/request/request.routes';
import { RequestService } from './modules/request/request.service';
import { TeamService } from './modules/team/team.service';
import { createTeamRouter } from './modules/team/team.routes';
import { DepartmentController } from './modules/department/department.controller';
import type { DepartmentRepository } from './modules/department/department.repository';
import { createDepartmentRouter } from './modules/department/department.routes';
import { DepartmentService } from './modules/department/department.service';
import { MemberController } from './modules/member/member.controller';
import type { MemberRepository } from './modules/member/member.repository';
import { createMemberRouter } from './modules/member/member.routes';
import { MemberService } from './modules/member/member.service';
import { TaskController } from './modules/task/task.controller';
import type { TaskRepository } from './modules/task/task.repository';
import { createAdminTaskRouter, createMemberTaskRouter } from './modules/task/task.routes';
import { TaskService } from './modules/task/task.service';
import { TimeTrackerController } from './modules/time-tracker/time-tracker.controller';
import type { TimeTrackerRepository } from './modules/time-tracker/time-tracker.repository';
import { createAdminTimeTrackerRouter, createTimeTrackerRouter } from './modules/time-tracker/time-tracker.routes';
import { TimeTrackerService } from './modules/time-tracker/time-tracker.service';
import { ok } from './utils/api-response';
import type { Clock } from './utils/clock';
import { logger } from './utils/logger';

export interface AppDeps {
  env: Env;
  memberRepository: MemberRepository;
  departmentRepository: DepartmentRepository;
  taskRepository: TaskRepository;
  requestRepository: RequestRepository;
  attachmentRepository: AttachmentRepository;
  fileStorage: FileStorage;
  timeTrackerRepository: TimeTrackerRepository;
  clock: Clock;
  /** bcrypt cost for new member passwords (default 12; tests use a low value for speed). */
  passwordCost?: number;
  /** Resolves if the database answers, rejects otherwise. */
  checkDatabase: () => Promise<void>;
}

/**
 * Composition root: wires modules together. Dependencies are injected so tests
 * can run the real HTTP stack against a fake repository and a fixed clock.
 */
export function createApp({
  env,
  memberRepository,
  departmentRepository,
  taskRepository,
  requestRepository,
  attachmentRepository,
  fileStorage,
  timeTrackerRepository,
  clock,
  passwordCost,
  checkDatabase,
}: AppDeps): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  if (env.NODE_ENV !== 'test') app.use(requestLogger);

  // Composition of the modules.
  const tokens = new TokenService(env);
  const authController = new AuthController(new AuthService(env, tokens, memberRepository));
  const memberService = new MemberService(memberRepository, departmentRepository, env.ADMIN_USERNAME, passwordCost);
  const memberController = new MemberController(memberService);
  const departmentController = new DepartmentController(new DepartmentService(departmentRepository, memberRepository, taskRepository));
  const requestController = new RequestController(new RequestService(requestRepository, memberRepository, departmentRepository, attachmentRepository));
  const attachmentController = new AttachmentController(new AttachmentService(attachmentRepository, requestRepository, fileStorage));
  const teamService = new TeamService(memberRepository, departmentRepository);
  const badgeController = new BadgeController(new BadgeService(taskRepository, requestRepository));
  const taskController = new TaskController(new TaskService(taskRepository, memberRepository, departmentRepository, clock, env.ADMIN_USERNAME));
  const timeTrackerController = new TimeTrackerController(
    new TimeTrackerService(timeTrackerRepository, memberRepository, taskRepository, clock, env.TIMEZONE),
  );

  app.get('/api/health', async (_req, res) => {
    try {
      await checkDatabase();
      // `timezone` lets the frontend resolve "today"/"yesterday" the same way the
      // server does (DLD §12/§14), instead of the browser's own local date.
      res.json(ok({ status: 'ok', database: 'up', time: clock.now().toISOString(), timezone: env.TIMEZONE }));
    } catch (err) {
      logger.error('Health check: database unreachable', err);
      res
        .status(503)
        .json({ success: false, code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable.' });
    }
  });

  app.use('/api/auth', createAuthRouter(authController));

  // Three account types, kept apart by authorization checks on every router:
  //   super admin → everything (the account in the environment)
  //   admin       → a department's leader: the "staff" routes below, but every one of them is
  //                 limited by the StaffScope requireStaff builds (their own department only);
  //                 departments themselves can only be changed by the super admin. ALSO their own
  //                 Time Tracker/Ledger and task self-service (For You, timer, log time), below,
  //                 for tasks assigned directly to them — exactly as a member's own works.
  //   member      → /api/time-tracker (their own ledger), /api/tasks (their own tasks),
  //                 /api/team (their department) and /api/requests (their own requests)
  const staff = [authenticate(tokens), requireStaff(memberRepository)];
  const member = [authenticate(tokens), requireMember(memberRepository)];
  const worker = [authenticate(tokens), requireWorker(memberRepository)];
  app.use('/api/members', ...staff, createMemberRouter(memberController));
  app.use('/api/departments', ...staff, createDepartmentRouter(departmentController));
  app.use('/api/admin/tasks', ...staff, createAdminTaskRouter(taskController));
  app.use('/api/admin/time-tracker', ...staff, createAdminTimeTrackerRouter(timeTrackerController));
  app.use('/api/admin/requests', ...staff, createStaffRequestRouter(requestController, attachmentController));
  app.use('/api/admin/badges', ...staff, createStaffBadgeRouter(badgeController));
  app.use('/api/time-tracker', ...worker, createTimeTrackerRouter(timeTrackerController));
  app.use('/api/tasks', ...worker, createMemberTaskRouter(taskController));
  app.use('/api/requests', ...member, createMemberRequestRouter(requestController, attachmentController));
  app.use('/api/team', ...member, createTeamRouter(teamService));
  app.use('/api/badges', ...member, createMemberBadgeRouter(badgeController));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
