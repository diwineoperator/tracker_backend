import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, setupAlice } from './helpers/test-app';

describe('admin: departments', () => {
  it('creates (trimmed), lists with usage counts, and rejects a duplicate name case-insensitively', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const created = await request(t.app).post('/api/departments').set('Authorization', adminAuth).send({ name: '  Fintech  ' });
    expect(created.status).toBe(201);
    // no leader yet — a department starts empty
    expect(created.body.data.department).toMatchObject({ name: 'Fintech', isActive: true, memberCount: 0, taskCount: 0, leaderId: null, leaderName: null });

    const member = (await request(t.app).post('/api/members').set('Authorization', adminAuth).send({ username: 'lead1@example.com', fullName: 'Lead 1', password: 'leader-pass', departmentIds: [created.body.data.department.id] })).body.data.member;
    const promoted = await request(t.app).put(`/api/departments/${created.body.data.department.id}/leader`).set('Authorization', adminAuth).send({ memberId: member.id });
    // the leader is not counted as one of the department's members
    expect(promoted.body.data.department).toMatchObject({ memberCount: 0, taskCount: 0, leaderName: 'Lead 1', leaderUsername: 'lead1@example.com' });

    for (const name of ['Fintech', 'FINTECH', 'fintech']) {
      const dup = await request(t.app).post('/api/departments').set('Authorization', adminAuth).send({ name });
      expect(dup.status, name).toBe(409);
      expect(dup.body.code).toBe('DEPARTMENT_NAME_TAKEN');
    }

    await request(t.app).post('/api/departments').set('Authorization', adminAuth).send({ name: 'Studio / Investment' });
    const list = await request(t.app).get('/api/departments').set('Authorization', adminAuth);
    expect(list.body.data.departments.map((d: { name: string }) => d.name)).toEqual(['Fintech', 'Studio / Investment']); // alphabetical
  });

  it('counts a department\'s members and open tasks', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth, 'Fintech');
    const m = await createMember(t, adminAuth, { username: 'a@example.com', departmentId: dept.id });
    await createMember(t, adminAuth, { username: 'b@example.com', departmentId: dept.id });
    await request(t.app).patch(`/api/members/${m.id}`).set('Authorization', adminAuth).send({ isActive: false });
    await request(t.app).post('/api/admin/tasks').set('Authorization', adminAuth).send({ title: 'Open one', departmentId: dept.id, memberId: (await request(t.app).get('/api/members').set('Authorization', adminAuth)).body.data.members.find((x: { username: string }) => x.username === 'b@example.com').id });

    const list = await request(t.app).get('/api/departments').set('Authorization', adminAuth);
    expect(list.body.data.departments[0]).toMatchObject({ memberCount: 2, activeMemberCount: 1, taskCount: 1, openTaskCount: 1 });
  });

  it('renames, blocks a rename onto another department, and validates', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const a = await createDepartment(t, adminAuth, 'Alpha');
    await createDepartment(t, adminAuth, 'Beta');

    const ok = await request(t.app).patch(`/api/departments/${a.id}`).set('Authorization', adminAuth).send({ name: 'Alpha Two' });
    expect(ok.body.data.department.name).toBe('Alpha Two');
    const clash = await request(t.app).patch(`/api/departments/${a.id}`).set('Authorization', adminAuth).send({ name: 'beta' });
    expect(clash.status).toBe(409);
    expect((await request(t.app).patch(`/api/departments/${a.id}`).set('Authorization', adminAuth).send({})).status).toBe(400);
    expect((await request(t.app).post('/api/departments').set('Authorization', adminAuth).send({ name: '   ' })).status).toBe(400);
    expect((await request(t.app).patch('/api/departments/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').set('Authorization', adminAuth).send({ name: 'X' })).status).toBe(404);
  });

  it('cannot deactivate a department with active members or open tasks; can once they are gone', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth, 'Fintech');
    const member = await createMember(t, adminAuth, { username: 'a@example.com', departmentId: dept.id });

    const blocked = await request(t.app).patch(`/api/departments/${dept.id}`).set('Authorization', adminAuth).send({ isActive: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('DEPARTMENT_HAS_DEPENDENCIES');
    expect(blocked.body.details).toMatchObject({ activeMembers: 1, openTasks: 0 });

    await request(t.app).patch(`/api/members/${member.id}`).set('Authorization', adminAuth).send({ isActive: false });
    const okNow = await request(t.app).patch(`/api/departments/${dept.id}`).set('Authorization', adminAuth).send({ isActive: false });
    expect(okNow.status).toBe(200);
    expect(okNow.body.data.department.isActive).toBe(false);
  });

  it('deletes a department together with its members (and all their data) and its tasks — other departments are untouched', async () => {
    const t = buildTestApp('2026-09-21T18:30:00.000Z');
    t.clock.advanceMinutes(60);
    const adminAuth = await loginAdmin(t);
    const used = await createDepartment(t, adminAuth, 'Used');
    const other = await createDepartment(t, adminAuth, 'Other');
    const empty = await createDepartment(t, adminAuth, 'Empty');
    const a = await createMember(t, adminAuth, { username: 'a@example.com', password: 'a-pass', departmentId: used.id });
    const carol = await createMember(t, adminAuth, { username: 'carol@example.com', password: 'carol-pass', departmentId: other.id });
    const aAuth = await login(t, 'a@example.com', 'a-pass');
    const carolAuth = await login(t, 'carol@example.com', 'carol-pass');
    const mk = async (title: string, departmentId: string, memberId: string) => (await request(t.app).post('/api/admin/tasks').set('Authorization', adminAuth).send({ title, departmentId, memberId })).body.data.task;
    const aTask = await mk('A task', used.id, a.id);
    await mk("Carol's task", other.id, carol.id);
    await request(t.app).post('/api/time-tracker').set('Authorization', aAuth).send({ category: 'WORK', durationMinutes: 40, taskId: aTask.id });
    await request(t.app).post('/api/time-tracker').set('Authorization', carolAuth).send({ category: 'LEARNING', durationMinutes: 20 });
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aAuth);

    // the warning's numbers
    const impact = await request(t.app).get(`/api/departments/${used.id}/impact`).set('Authorization', adminAuth);
    expect(impact.body.data.impact).toEqual({ members: 2, keptMembers: 0, tasks: 1, timeEntries: 1, closedDays: 1 }); // the member and the department's leader
    expect((await request(t.app).get('/api/departments/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11/impact').set('Authorization', adminAuth)).status).toBe(404);
    expect((await request(t.app).get(`/api/departments/${used.id}/impact`).set('Authorization', carolAuth)).status).toBe(403);

    expect((await request(t.app).delete(`/api/departments/${used.id}`).set('Authorization', adminAuth)).status).toBe(204);
    const members = (await request(t.app).get('/api/members').set('Authorization', adminAuth)).body.data.members;
    // nobody from the deleted department is left (its leader went too); the other departments' people are untouched
    expect(members.filter((m: { departmentIds: string[] }) => m.departmentIds.includes(used.id))).toEqual([]);
    expect(members.some((m: { id: string }) => m.id === carol.id)).toBe(true);
    expect(members).toHaveLength(3); // carol + the leaders of Other and Empty
    expect((await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks.map((x: { title: string }) => x.title)).toEqual(["Carol's task"]);
    expect(t.repos.timeTracker.trackers.map((x) => x.memberId)).toEqual([carol.id]);
    expect(t.repos.timeTracker.ledger.every((e) => e.memberId === carol.id)).toBe(true);
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', carolAuth)).body.data.totals).toMatchObject({ LEARNING: 20 });

    expect((await request(t.app).delete(`/api/departments/${empty.id}`).set('Authorization', adminAuth)).status).toBe(204);
    expect((await request(t.app).delete(`/api/departments/${empty.id}`).set('Authorization', adminAuth)).status).toBe(404);
  });

  it('is admin-only: a member gets 403, an unauthenticated caller gets 401', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    for (const call of [
      request(t.app).get('/api/departments'),
      request(t.app).post('/api/departments').send({ name: 'X' }),
      request(t.app).patch('/api/departments/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').send({ name: 'X' }),
      request(t.app).delete('/api/departments/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11'),
      request(t.app).get('/api/departments/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11/impact'),
    ]) {
      expect((await call.set('Authorization', aliceAuth)).status).toBe(403);
    }
    expect((await request(t.app).get('/api/departments')).status).toBe(401);
  });
});

describe('admin: a member belongs to a department', () => {
  it('a new member needs an existing, active department', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const body = { username: 'x@example.com', fullName: 'X', password: 'secret123' };
    const post = (extra: object) => request(t.app).post('/api/members').set('Authorization', adminAuth).send({ ...body, ...extra });

    expect((await post({})).status).toBe(400); // missing
    expect((await post({ departmentIds: ['not-a-uuid'] })).status).toBe(400);
    expect((await post({ departmentIds: [] })).status).toBe(400); // at least one
    const unknown = await post({ departmentIds: ['0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11'] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('DEPARTMENT_NOT_FOUND');

    const dept = await createDepartment(t, adminAuth, 'Dormant');
    await request(t.app).patch(`/api/departments/${dept.id}`).set('Authorization', adminAuth).send({ isActive: false });
    const inactive = await post({ departmentIds: [dept.id] });
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('DEPARTMENT_INACTIVE');
  });

  it('an admin can move a member to another active department', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const a = await createDepartment(t, adminAuth, 'Alpha');
    const b = await createDepartment(t, adminAuth, 'Beta');
    const m = await createMember(t, adminAuth, { username: 'a@example.com', departmentId: a.id });

    const moved = await request(t.app).patch(`/api/members/${m.id}`).set('Authorization', adminAuth).send({ departmentIds: [b.id] });
    expect(moved.status).toBe(200);
    expect(moved.body.data.member.departmentIds).toEqual([b.id]);
    expect((await request(t.app).patch(`/api/members/${m.id}`).set('Authorization', adminAuth).send({ departmentIds: ['0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11'] })).status).toBe(404);
  });

  it('members created before departments existed (no department) can still sign in and be edited', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    // Simulate a legacy row: inserted straight into the repository, no department.
    const legacy = await t.repos.members.create({ username: 'legacy@example.com', fullName: 'Legacy', passwordHash: (await import('bcryptjs')).default.hashSync('pw', 4), departmentIds: ['x'] });
    t.repos.members.rows.find((r) => r.id === legacy.id)!.departmentIds = [];

    expect(await login(t, 'legacy@example.com', 'pw')).toContain('Bearer ');
    const renamed = await request(t.app).patch(`/api/members/${legacy.id}`).set('Authorization', adminAuth).send({ fullName: 'Legacy Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.member.departmentIds).toEqual([]);
  });
});
