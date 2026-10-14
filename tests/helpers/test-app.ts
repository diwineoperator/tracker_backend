import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../../src/app';
import { loadEnv } from '../../src/config/env';
import { FakeClock } from './fake-clock';
import { InMemoryAttachmentRepository, InMemoryFileStorage } from './in-memory-attachment.repository';
import { InMemoryDepartmentRepository } from './in-memory-department.repository';
import { InMemoryMemberRepository } from './in-memory-member.repository';
import { InMemoryRequestRepository } from './in-memory-request.repository';
import { InMemoryTaskRepository } from './in-memory-task.repository';
import { InMemoryTimeTrackerRepository } from './in-memory-time-tracker.repository';

export const TEST_ADMIN = { username: 'balaji', password: '123' };

export function buildTestApp(startAt = '2026-09-21T06:30:00.000Z', options: { adminUsername?: string } = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    ADMIN_USERNAME: options.adminUsername ?? TEST_ADMIN.username,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(TEST_ADMIN.password, 4),
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    JWT_EXPIRES_IN: '1h',
    TIMEZONE: 'Asia/Kolkata',
  });
  const clock = new FakeClock(new Date(startAt));
  const members = new InMemoryMemberRepository();
  const departments = new InMemoryDepartmentRepository(() => members.rows);
  const timeTracker = new InMemoryTimeTrackerRepository();
  const tasks = new InMemoryTaskRepository(() => timeTracker.trackers);
  const requests = new InMemoryRequestRepository();
  const attachments = new InMemoryAttachmentRepository();
  const files = new InMemoryFileStorage();
  members.related = {
    impact: (memberId) => ({
      tasks: tasks.rows.filter((x) => x.memberId === memberId).length,
      timeEntries: timeTracker.trackers.filter((x) => x.memberId === memberId).length,
      closedDays: timeTracker.closedDayCount(memberId),
    }),
    removeAll: (memberId) => {
      timeTracker.removeAllFor(memberId);
      requests.removeForMember(memberId);
      for (let i = tasks.rows.length - 1; i >= 0; i--) if (tasks.rows[i]!.memberId === memberId) tasks.rows.splice(i, 1);
    },
  };
  /** Who a department's deletion takes with it: its leader, and members whose ONLY department it is. */
  const whoGoes = (departmentId: string) => {
    const inDept = members.rows.filter((m) => m.role === 'MEMBER' && m.departmentIds.includes(departmentId));
    return { doomed: inDept.filter((m) => m.departmentIds.length === 1).map((m) => m.id), kept: inDept.filter((m) => m.departmentIds.length > 1).map((m) => m.id), leader: members.rows.find((m) => m.role === 'ADMIN' && m.departmentIds.includes(departmentId))?.id };
  };
  departments.related = {
    impact: (departmentId) => {
      const { doomed, kept, leader } = whoGoes(departmentId);
      return {
        members: doomed.length + (leader ? 1 : 0),
        keptMembers: kept.length,
        tasks: tasks.rows.filter((x) => x.departmentId === departmentId || doomed.includes(x.memberId)).length,
        timeEntries: timeTracker.trackers.filter((x) => doomed.includes(x.memberId)).length,
        closedDays: doomed.reduce((n, id) => n + timeTracker.closedDayCount(id), 0),
      };
    },
    removeAll: (departmentId) => {
      const { doomed, kept, leader } = whoGoes(departmentId);
      // entries of anyone who stays that point at a doomed task keep their time, lose the link
      const doomedTasks = new Set(tasks.rows.filter((x) => x.departmentId === departmentId).map((x) => x.id));
      for (const t of timeTracker.trackers) if (t.taskId && doomedTasks.has(t.taskId) && !doomed.includes(t.memberId)) t.taskId = null;
      requests.removeForDepartment(departmentId);
      for (const id of doomed) members.related.removeAll(id);
      for (let i = tasks.rows.length - 1; i >= 0; i--) if (doomedTasks.has(tasks.rows[i]!.id) || doomed.includes(tasks.rows[i]!.memberId)) tasks.rows.splice(i, 1);
      const removeIds = [...doomed, ...(leader ? [leader] : [])];
      for (let i = members.rows.length - 1; i >= 0; i--) if (removeIds.includes(members.rows[i]!.id)) members.rows.splice(i, 1);
      // members who stay just lose this membership
      for (const id of kept) { const m = members.rows.find((x) => x.id === id)!; m.departmentIds = m.departmentIds.filter((d) => d !== departmentId); }
    },
  };
  const app = createApp({
    env,
    memberRepository: members,
    departmentRepository: departments,
    taskRepository: tasks,
    requestRepository: requests,
    attachmentRepository: attachments,
    fileStorage: files,
    timeTrackerRepository: timeTracker,
    clock,
    passwordCost: 4, // fast bcrypt for tests
    checkDatabase: async () => {},
  });
  return { app, env, clock, repos: { members, departments, tasks, requests, timeTracker, attachments }, files };
}

export type TestApp = ReturnType<typeof buildTestApp>;

/** POST /api/auth/login and return the ready-to-use Authorization header value. */
export async function login(t: TestApp, username: string, password: string): Promise<string> {
  const res = await request(t.app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return `Bearer ${res.body.data.token}`;
}

export const loginAdmin = (t: TestApp) => login(t, TEST_ADMIN.username, TEST_ADMIN.password);

export const LEADER_PASSWORD = 'leader-pass';

/** The sign-in email a helper-created department's leader gets: "<name>.leader@example.com". */
export const leaderEmail = (departmentName: string) => `${departmentName.toLowerCase().replace(/[^a-z0-9]/g, '')}.leader@example.com`;

/**
 * Creates a department, then gives it a leader — through the real super-admin API — by creating a
 * member in it and promoting them: a department starts with none, so this mirrors the real flow
 * (create → add a member → assign them as leader) while keeping this helper's contract (a
 * `loginLeader(t, name)`-able department) identical for every one of its many callers.
 */
export async function createDepartment(t: TestApp, superAdminAuth: string, name = 'Engineering') {
  const created = await request(t.app).post('/api/departments').set('Authorization', superAdminAuth).send({ name });
  if (created.status !== 201) throw new Error(`createDepartment failed: ${created.status} ${JSON.stringify(created.body)}`);
  const departmentId = created.body.data.department.id as string;

  const member = await request(t.app)
    .post('/api/members')
    .set('Authorization', superAdminAuth)
    .send({ username: leaderEmail(name), fullName: `${name} Leader`, password: LEADER_PASSWORD, departmentIds: [departmentId] });
  if (member.status !== 201) throw new Error(`createDepartment (leader member) failed: ${member.status} ${JSON.stringify(member.body)}`);

  const promoted = await request(t.app)
    .put(`/api/departments/${departmentId}/leader`)
    .set('Authorization', superAdminAuth)
    .send({ memberId: member.body.data.member.id });
  if (promoted.status !== 200) throw new Error(`createDepartment (assign leader) failed: ${promoted.status} ${JSON.stringify(promoted.body)}`);
  return promoted.body.data.department as { id: string; name: string; isActive: boolean; leaderId: string | null; leaderName: string | null; leaderUsername: string | null };
}

/** Signs a department's leader in (the account createDepartment made). */
export const loginLeader = (t: TestApp, departmentName: string) => login(t, leaderEmail(departmentName), LEADER_PASSWORD);

/** The department helper-created members join by default — created on first use. */
async function defaultDepartmentId(t: TestApp, adminAuth: string): Promise<string> {
  return t.repos.departments.rows[0]?.id ?? (await createDepartment(t, adminAuth)).id;
}

/** Creates a member through the real admin API (in the default department unless `departmentId` says otherwise). */
export async function createMember(
  t: TestApp,
  adminAuth: string,
  input: { username: string; fullName?: string; password?: string; departmentId?: string; departmentIds?: string[] },
) {
  const res = await request(t.app)
    .post('/api/members')
    .set('Authorization', adminAuth)
    .send({ fullName: 'Test Member', password: 'secret123', ...input, departmentIds: input.departmentIds ?? [input.departmentId ?? (await defaultDepartmentId(t, adminAuth))] });
  if (res.status !== 201) throw new Error(`createMember failed: ${res.status} ${JSON.stringify(res.body)}`);
  const member = res.body.data.member as { id: string; username: string; fullName: string; isActive: boolean; departmentIds: string[]; shared: boolean; role: 'MEMBER' | 'ADMIN' };
  // `departmentId` = their first department, for tests that only care about the common one-department case.
  return { ...member, departmentId: (member.departmentIds[0] ?? null) as string | null };
}

/** admin + one member (alice), both authenticated. Used by most tests. */
export async function setupAlice(t: TestApp) {
  const adminAuth = await loginAdmin(t);
  const alice = await createMember(t, adminAuth, { username: 'alice@example.com', fullName: 'Alice A', password: 'alice-pass' });
  const aliceAuth = await login(t, 'alice@example.com', 'alice-pass');
  return { adminAuth, alice, aliceAuth };
}
