import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, setupAlice, TEST_ADMIN } from './helpers/test-app';

describe('admin: member management', () => {
  it('creates a member; the response never contains a password or hash', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth);
    const res = await request(t.app)
      .post('/api/members')
      .set('Authorization', adminAuth)
      .send({ username: '  Carol.D@Example.COM ', fullName: '  Carol Doe ', password: 'carol-pass', departmentIds: [dept.id] });

    expect(res.status).toBe(201);
    expect(res.body.data.member).toMatchObject({
      username: 'carol.d@example.com', // trimmed + lower-cased
      fullName: 'Carol Doe',
      isActive: true,
      departmentIds: [dept.id],
      shared: false,
      role: 'MEMBER',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|carol-pass|\$2[aby]\$/i);
  });

  it('rejects a duplicate email (case-insensitive)', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dave = await createMember(t, adminAuth, { username: 'dave@example.com' });

    for (const username of ['DAVE@EXAMPLE.COM', 'Dave@Example.com']) {
      const res = await request(t.app)
        .post('/api/members')
        .set('Authorization', adminAuth)
        .send({ username, fullName: 'X', password: 'secret123', departmentIds: [dave.departmentId] });
      expect(res.status, username).toBe(409);
      expect(res.body.code).toBe('USERNAME_TAKEN');
    }
  });

  it('the admin sign-in name is reserved: no member can take it', async () => {
    // An admin whose sign-in name is an email address could otherwise collide with a member's.
    const t = buildTestApp('2026-09-21T06:30:00.000Z', { adminUsername: 'admin@company.com' });
    const adminAuth = await login(t, 'admin@company.com', TEST_ADMIN.password);
    const dept = await createDepartment(t, adminAuth);
    const res = await request(t.app)
      .post('/api/members')
      .set('Authorization', adminAuth)
      .send({ username: 'ADMIN@Company.com', fullName: 'Impostor', password: 'x', departmentIds: [dept.id] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USERNAME_TAKEN');
  });

  it.each([
    ['not an email', { username: 'erin', fullName: 'X', password: 'secret123' }],
    ['email with spaces', { username: 'a b@example.com', fullName: 'X', password: 'secret123' }],
    ['email over 100 characters', { username: `${'x'.repeat(95)}@example.com`, fullName: 'X', password: 'secret123' }],
    ['blank full name', { username: 'erin@example.com', fullName: '   ', password: 'secret123' }],
    ['empty password', { username: 'erin@example.com', fullName: 'X', password: '' }],
    ['password over bcrypt\'s 72-byte limit', { username: 'erin@example.com', fullName: 'X', password: 'x'.repeat(73) }],
    ['missing password', { username: 'erin@example.com', fullName: 'X' }],
  ])('validates: %s', async (_label, body) => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth);
    // Every case is otherwise valid: the ONE bad field is what must be rejected.
    const res = await request(t.app).post('/api/members').set('Authorization', adminAuth).send({ departmentIds: [dept.id], ...body });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('has no password rules beyond "not empty": even 1 character works', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth);
    for (const [username, password] of [['one@example.com', '1'], ['numbers@example.com', '123'], ['spaces@example.com', '   ']]) {
      const res = await request(t.app).post('/api/members').set('Authorization', adminAuth).send({ username, fullName: 'X', password, departmentIds: [dept.id] });
      expect(res.status, password).toBe(201);
      expect(await login(t, username!, password!)).toContain('Bearer '); // and they can actually sign in with it
    }
  });

  it('lists members', async () => {
    const t = buildTestApp();
    const { adminAuth } = await setupAlice(t);
    const res = await request(t.app).get('/api/members').set('Authorization', adminAuth);
    // the super admin sees everyone: Alice and her department's leader
    expect(res.body.data.members).toHaveLength(2);
    expect(res.body.data.members[0]).toMatchObject({ username: 'alice@example.com', fullName: 'Alice A', isActive: true, role: 'MEMBER' });
    expect(res.body.data.members[1]).toMatchObject({ role: 'ADMIN' });
  });

  it('edits the name and enables/disables', async () => {
    const t = buildTestApp();
    const { adminAuth, alice } = await setupAlice(t);

    const renamed = await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ fullName: 'Alice Renamed' });
    expect(renamed.body.data.member.fullName).toBe('Alice Renamed');

    const off = await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: false });
    expect(off.body.data.member.isActive).toBe(false);
    const on = await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: true });
    expect(on.body.data.member.isActive).toBe(true);
    expect(await login(t, 'alice@example.com', 'alice-pass')).toContain('Bearer ');
  });

  it('resets a password: the new one works, the old one does not', async () => {
    const t = buildTestApp();
    const { adminAuth, alice } = await setupAlice(t);
    await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ password: 'brand-new-pass' });

    expect((await request(t.app).post('/api/auth/login').send({ username: 'alice@example.com', password: 'alice-pass' })).status).toBe(401);
    expect(await login(t, 'alice@example.com', 'brand-new-pass')).toContain('Bearer ');
  });

  it('404s for an unknown member, 400s for an empty or malformed update', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const unknown = await request(t.app)
      .patch('/api/members/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11')
      .set('Authorization', adminAuth)
      .send({ fullName: 'X' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('MEMBER_NOT_FOUND');

    const { alice } = await setupAlice(t);
    expect((await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({})).status).toBe(400);
    expect((await request(t.app).patch('/api/members/nope').set('Authorization', adminAuth).send({ fullName: 'X' })).status).toBe(400);
  });
});

describe('admin: deleting a member', () => {
  it('deletes a member with no ledger history', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com' });

    const res = await request(t.app).delete(`/api/members/${bob.id}`).set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const list = await request(t.app).get('/api/members').set('Authorization', adminAuth);
    expect(list.body.data.members.map((x: { id: string }) => x.id)).not.toContain(bob.id);
  });

  it('reports what a delete would remove, then deletes the member together with their tasks, time and day closures — and nobody else\'s', async () => {
    const t = buildTestApp('2026-09-21T18:30:00.000Z');
    t.clock.advanceMinutes(60);
    const adminAuth = await loginAdmin(t);
    const dept = await createDepartment(t, adminAuth, 'Fintech');
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', fullName: 'Bob', password: 'bob-pass', departmentIds: [dept.id] });
    const carol = await createMember(t, adminAuth, { username: 'carol@example.com', fullName: 'Carol', password: 'carol-pass', departmentIds: [dept.id] });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    const carolAuth = await login(t, 'carol@example.com', 'carol-pass');
    const mk = async (title: string, memberId: string) => (await request(t.app).post('/api/admin/tasks').set('Authorization', adminAuth).send({ title, departmentId: dept.id, memberId })).body.data.task;
    const bobsTask = await mk('Bob task', bob.id);
    await mk("Carol's", carol.id);
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'WORK', durationMinutes: 30, taskId: bobsTask.id });
    await request(t.app).post('/api/time-tracker').set('Authorization', carolAuth).send({ category: 'LEARNING', durationMinutes: 20 });
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', bobAuth);

    const impact = await request(t.app).get(`/api/members/${bob.id}/impact`).set('Authorization', adminAuth);
    expect(impact.body.data.impact).toEqual({ tasks: 1, timeEntries: 1, closedDays: 1 });
    expect((await request(t.app).get('/api/members/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11/impact').set('Authorization', adminAuth)).status).toBe(404);
    expect((await request(t.app).get(`/api/members/${bob.id}/impact`).set('Authorization', carolAuth)).status).toBe(403);

    expect((await request(t.app).delete(`/api/members/${bob.id}`).set('Authorization', adminAuth)).status).toBe(204);
    expect(t.repos.tasks.rows.map((x) => x.title)).toEqual(["Carol's"]);
    expect(t.repos.timeTracker.trackers.map((x) => x.memberId)).toEqual([carol.id]);
    expect(t.repos.timeTracker.ledger.every((e) => e.memberId === carol.id)).toBe(true);
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', carolAuth)).body.data.totals).toMatchObject({ LEARNING: 20 });
  });

  it('404s for an unknown or already-deleted member', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const missing = await request(t.app).delete('/api/members/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').set('Authorization', adminAuth);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('MEMBER_NOT_FOUND');

    const bob = await createMember(t, adminAuth, { username: 'bob2@example.com' });
    expect((await request(t.app).delete(`/api/members/${bob.id}`).set('Authorization', adminAuth)).status).toBe(204);
    const again = await request(t.app).delete(`/api/members/${bob.id}`).set('Authorization', adminAuth);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('400s for a malformed id', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    expect((await request(t.app).delete('/api/members/not-a-uuid').set('Authorization', adminAuth)).status).toBe(400);
  });

  it('is admin-only: a member gets 403, an unauthenticated caller gets 401 — the member survives both', async () => {
    const t = buildTestApp();
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    expect((await request(t.app).delete(`/api/members/${alice.id}`).set('Authorization', aliceAuth)).status).toBe(403);
    expect((await request(t.app).delete(`/api/members/${alice.id}`)).status).toBe(401);

    const list = await request(t.app).get('/api/members').set('Authorization', adminAuth);
    expect(list.body.data.members.map((x: { id: string }) => x.id)).toContain(alice.id);
  });
});
