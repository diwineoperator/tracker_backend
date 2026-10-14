import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, LEADER_PASSWORD, leaderEmail, login, loginAdmin, loginLeader, type TestApp } from './helpers/test-app';

const LOCAL_MIDNIGHT_UTC = '2026-09-21T18:30:00.000Z'; // local midnight of 2026-09-22 IST
const UNKNOWN_ID = '0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11';

/**
 * Two departments, each with its leader: Fintech (leader + alice + bob) and Studio (leader + carol).
 * Everyone is signed in. The super admin is the account from the environment.
 */
async function setupOrg(t: TestApp) {
  const superAuth = await loginAdmin(t);
  const fintech = await createDepartment(t, superAuth, 'Fintech');
  const studio = await createDepartment(t, superAuth, 'Studio');
  const alice = await createMember(t, superAuth, { username: 'alice@example.com', fullName: 'Alice A', password: 'alice-pass', departmentId: fintech.id });
  const bob = await createMember(t, superAuth, { username: 'bob@example.com', fullName: 'Bob B', password: 'bob-pass', departmentId: fintech.id });
  const carol = await createMember(t, superAuth, { username: 'carol@example.com', fullName: 'Carol C', password: 'carol-pass', departmentId: studio.id });
  return {
    superAuth,
    fintech,
    studio,
    alice,
    bob,
    carol,
    fLead: await loginLeader(t, 'Fintech'),
    sLead: await loginLeader(t, 'Studio'),
    aliceAuth: await login(t, 'alice@example.com', 'alice-pass'),
    bobAuth: await login(t, 'bob@example.com', 'bob-pass'),
    carolAuth: await login(t, 'carol@example.com', 'carol-pass'),
  };
}

const api = (t: TestApp) => ({
  get: (path: string, auth?: string) => (auth ? request(t.app).get(path).set('Authorization', auth) : request(t.app).get(path)),
  post: (path: string, auth: string, body: object = {}) => request(t.app).post(path).set('Authorization', auth).send(body),
  patch: (path: string, auth: string, body: object) => request(t.app).patch(path).set('Authorization', auth).send(body),
  put: (path: string, auth: string, body: object = {}) => request(t.app).put(path).set('Authorization', auth).send(body),
  del: (path: string, auth: string) => request(t.app).delete(path).set('Authorization', auth),
});

describe('roles: sign-in and role separation', () => {
  it('a department leader signs in as "admin" with their department; the super admin as "super_admin"; a member as "member"', async () => {
    const t = buildTestApp();
    const { fintech } = await setupOrg(t);
    const lead = await request(t.app).post('/api/auth/login').send({ username: leaderEmail('Fintech'), password: LEADER_PASSWORD });
    expect(lead.body.data.user).toMatchObject({ role: 'admin', departmentIds: [fintech.id], fullName: 'Fintech Leader' });
    const superAdmin = await request(t.app).post('/api/auth/login').send({ username: 'balaji', password: 'x' });
    expect(superAdmin.status).toBe(401); // wrong password / not the configured super admin
    const member = await request(t.app).post('/api/auth/login').send({ username: 'alice@example.com', password: 'alice-pass' });
    expect(member.body.data.user.role).toBe('member');
  });

  it('a leader is not a member for Team/Requests, but DOES reach their own Tasks/Time Tracker self-service (work assigned directly to them); members are refused on every admin-side route', async () => {
    const t = buildTestApp();
    const { fLead, aliceAuth } = await setupOrg(t);
    const a = api(t);
    // Their own work — exactly what a member's self-service reaches, now also open to a leader.
    for (const path of ['/api/time-tracker/today', '/api/tasks']) {
      expect((await a.get(path, fLead)).status, path).toBe(200);
    }
    // Still not a member for these — sending/reading a Request, or My Team.
    for (const path of ['/api/team', '/api/requests', '/api/requests/targets']) {
      expect((await a.get(path, fLead)).status, path).toBe(403);
    }
    for (const path of ['/api/members', '/api/departments', '/api/admin/tasks', '/api/admin/time-tracker', '/api/admin/time-tracker/history?date=2026-09-22', '/api/admin/requests']) {
      const res = await a.get(path, aliceAuth);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    for (const path of ['/api/members', '/api/departments', '/api/admin/tasks', '/api/admin/requests', '/api/tasks', '/api/time-tracker/today']) expect((await a.get(path)).status, path).toBe(401);
  });

  it('a token issued before the role split ("admin" with the fixed subject) still means the super admin', async () => {
    const t = buildTestApp();
    await setupOrg(t);
    const legacy = jwt.sign({ role: 'admin', username: t.env.ADMIN_USERNAME }, t.env.JWT_SECRET, { algorithm: 'HS256', subject: 'admin', expiresIn: '1h' });
    const res = await api(t).get('/api/departments', `Bearer ${legacy}`);
    expect(res.status).toBe(200);
    expect(res.body.data.departments).toHaveLength(2); // sees every department
  });

  it('disabling or deleting a leader cuts off their existing token immediately; the department is left leaderless', async () => {
    const t = buildTestApp();
    const { superAuth, fintech, studio, fLead, sLead } = await setupOrg(t);
    const a = api(t);
    expect((await a.get('/api/members', fLead)).status).toBe(200);

    await a.patch(`/api/members/${fintech.leaderId}`, superAuth, { isActive: false });
    const disabled = await a.get('/api/members', fLead);
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('ACCOUNT_DISABLED');

    await a.del(`/api/members/${studio.leaderId}`, superAuth);
    expect((await a.get('/api/members', sLead)).status).toBe(401); // the account no longer exists
    expect((await a.get('/api/departments', superAuth)).body.data.departments.find((d: { id: string }) => d.id === studio.id).leaderId).toBeNull();
  });
});

describe('departments: the super admin manages them; a leader only reads their own', () => {
  it('a leader sees only their own department and cannot create, edit, delete or add leaders', async () => {
    const t = buildTestApp();
    const { fintech, studio, fLead } = await setupOrg(t);
    const a = api(t);
    const list = await a.get('/api/departments', fLead);
    expect(list.body.data.departments.map((d: { id: string }) => d.id)).toEqual([fintech.id]);
    expect(list.body.data.departments[0]).toMatchObject({ leaderName: 'Fintech Leader', memberCount: 2 });

    for (const res of [
      await a.post('/api/departments', fLead, { name: 'New' }),
      await a.put(`/api/departments/${studio.id}/leader`, fLead, { memberId: t.repos.members.rows.find((m) => m.username === 'carol@example.com')!.id }),
      await a.del(`/api/departments/${studio.id}/leader`, fLead),
      await a.patch(`/api/departments/${fintech.id}`, fLead, { name: 'Renamed' }),
      await a.patch(`/api/departments/${studio.id}`, fLead, { isActive: false }),
      await a.del(`/api/departments/${studio.id}`, fLead),
      await a.get(`/api/departments/${studio.id}/impact`, fLead),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(t.repos.departments.rows.map((d) => d.name).sort()).toEqual(['Fintech', 'Studio']);
  });

  it('a department is created with no leader; the super admin gives it one by promoting an existing member', async () => {
    const t = buildTestApp();
    const superAuth = await loginAdmin(t);
    const a = api(t);
    const created = await a.post('/api/departments', superAuth, { name: 'Ops' });
    expect(created.status).toBe(201);
    expect(created.body.data.department).toMatchObject({ name: 'Ops', leaderId: null, leaderName: null });

    const taken = await a.post('/api/departments', superAuth, { name: 'Ops' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('DEPARTMENT_NAME_TAKEN');
    expect(t.repos.departments.rows.map((d) => d.name)).toEqual(['Ops']);

    const opsId = created.body.data.department.id;
    const lead = (await a.post('/api/members', superAuth, { username: 'ops.lead@example.com', fullName: 'Ops Lead', password: 'pw-pw-pw', departmentIds: [opsId] })).body.data.member;
    const assigned = await a.put(`/api/departments/${opsId}/leader`, superAuth, { memberId: lead.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.department).toMatchObject({ leaderId: lead.id, leaderName: 'Ops Lead' });
    expect((await a.get('/api/members', superAuth)).body.data.members.find((m: { id: string }) => m.id === lead.id)).toMatchObject({ role: 'ADMIN', departmentIds: [opsId] });
  });

  it('only ONE leader per department: assigning a new one changes it (the old one is demoted); it can be removed and reassigned', async () => {
    const t = buildTestApp();
    const { superAuth, fintech, alice, bob } = await setupOrg(t);
    const a = api(t);
    // Someone outside the department, an inactive member, and an already-leading account are all refused.
    const carolId = t.repos.members.rows.find((m) => m.username === 'carol@example.com')!.id;
    const outside = await a.put(`/api/departments/${fintech.id}/leader`, superAuth, { memberId: carolId });
    expect(outside.status).toBe(409);
    expect(outside.body.code).toBe('MEMBER_NOT_IN_DEPARTMENT');

    await a.patch(`/api/members/${bob.id}`, superAuth, { isActive: false });
    const inactive = await a.put(`/api/departments/${fintech.id}/leader`, superAuth, { memberId: bob.id });
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('MEMBER_INACTIVE');

    const alreadyLeading = await a.put(`/api/departments/${fintech.id}/leader`, superAuth, { memberId: fintech.leaderId });
    expect(alreadyLeading.status).toBe(409);
    expect(alreadyLeading.body.code).toBe('MEMBER_ALREADY_LEADER');

    // Changing the leader to alice demotes the current one back to a plain member (no department).
    const oldLeaderId = fintech.leaderId!;
    const changed = await a.put(`/api/departments/${fintech.id}/leader`, superAuth, { memberId: alice.id });
    expect(changed.status).toBe(200);
    expect(changed.body.data.department.leaderId).toBe(alice.id);
    expect((await a.get('/api/members', superAuth)).body.data.members.find((m: { id: string }) => m.id === oldLeaderId)).toMatchObject({ role: 'MEMBER', departmentIds: [] });

    // Removed entirely: the department goes leaderless, and the account is a plain member again.
    const removed = await a.del(`/api/departments/${fintech.id}/leader`, superAuth);
    expect(removed.status).toBe(200);
    expect(removed.body.data.department.leaderId).toBeNull();
    expect((await a.get('/api/members', superAuth)).body.data.members.find((m: { id: string }) => m.id === alice.id)).toMatchObject({ role: 'MEMBER', departmentIds: [] });
    // Removing again (already leaderless) is a harmless no-op, not an error.
    expect((await a.del(`/api/departments/${fintech.id}/leader`, superAuth)).status).toBe(200);
  });

  it('GET /departments/leaders: any staff caller sees who leads OTHER departments — never their own, never a leaderless one', async () => {
    const t = buildTestApp();
    const { fintech, studio, fLead, sLead, superAuth } = await setupOrg(t);
    const a = api(t);
    const ops = await createDepartment(t, superAuth, 'Ops'); // has a leader (helper promotes one)
    await a.del(`/api/departments/${ops.id}/leader`, superAuth); // ...then goes leaderless

    const forFLead = await a.get('/api/departments/leaders', fLead);
    expect(forFLead.status).toBe(200);
    expect(forFLead.body.data.departments).toEqual([{ id: studio.id, name: 'Studio', leaderId: studio.leaderId, leaderName: 'Studio Leader' }]); // not Fintech (self), not leaderless Ops

    const forSLead = await a.get('/api/departments/leaders', sLead);
    expect(forSLead.body.data.departments.map((d: { id: string }) => d.id)).toEqual([fintech.id]);

    const forSuper = await a.get('/api/departments/leaders', superAuth);
    expect(forSuper.body.data.departments.map((d: { id: string }) => d.id).sort()).toEqual([fintech.id, studio.id].sort()); // every leader, including their "own" (there is none)

    expect((await a.get('/api/departments/leaders')).status).toBe(401); // signed out
  });
});

describe('members: a leader manages only their own department\'s members', () => {
  it('lists only own-department members — never other departments, and never leaders', async () => {
    const t = buildTestApp();
    const { alice, bob, fLead, superAuth } = await setupOrg(t);
    const a = api(t);
    const res = await a.get('/api/members', fLead);
    expect(res.body.data.members.map((m: { id: string }) => m.id).sort()).toEqual([alice.id, bob.id].sort());
    expect(JSON.stringify(res.body)).not.toMatch(/carol|Studio/);
    expect((await a.get('/api/members', superAuth)).body.data.members).toHaveLength(5); // super admin: 3 members + 2 leaders
  });

  it('creates members into their own department only — never another department (or a second one)', async () => {
    const t = buildTestApp();
    const { fintech, studio, fLead } = await setupOrg(t);
    const a = api(t);
    const body = { username: 'dave@example.com', fullName: 'Dave D', password: 'dave-pass' };

    const own = await a.post('/api/members', fLead, body); // no departments sent: taken from the session
    expect(own.status).toBe(201);
    expect(own.body.data.member).toMatchObject({ departmentIds: [fintech.id], role: 'MEMBER', shared: false });

    expect((await a.post('/api/members', fLead, { ...body, username: 'e@example.com', departmentIds: [studio.id] })).status).toBe(403); // another department
    expect((await a.post('/api/members', fLead, { ...body, username: 'f@example.com', departmentIds: [fintech.id, studio.id] })).status).toBe(403); // a second department is the super admin's call
    expect(t.repos.members.rows.some((m) => m.username === 'e@example.com' || m.username === 'f@example.com')).toBe(false);
  });

  it("cannot see, edit, move or delete another department's member — reported as not found — or a leader", async () => {
    const t = buildTestApp();
    const { alice, carol, studio, fintech, fLead } = await setupOrg(t);
    const a = api(t);
    expect((await a.patch(`/api/members/${carol.id}`, fLead, { fullName: 'Hacked' })).status).toBe(404);
    expect((await a.get(`/api/members/${carol.id}/impact`, fLead)).status).toBe(404);
    expect((await a.del(`/api/members/${carol.id}`, fLead)).status).toBe(404);
    expect((await a.patch(`/api/members/${studio.leaderId}`, fLead, { isActive: false })).status).toBe(404); // another leader
    expect((await a.patch(`/api/members/${fintech.leaderId}`, fLead, { fullName: 'Me' })).status).toBe(404); // even their own leader row
    expect(t.repos.members.rows.find((m) => m.id === carol.id)!.fullName).toBe('Carol C');

    // structural changes on their own members are the super admin's
    expect((await a.patch(`/api/members/${alice.id}`, fLead, { departmentIds: [studio.id] })).status).toBe(403);
    expect((await a.patch(`/api/members/${alice.id}`, fLead, { departmentIds: [fintech.id] })).status).toBe(403); // even "the same": memberships aren't theirs to change
    // …but the everyday edits are theirs
    expect((await a.patch(`/api/members/${alice.id}`, fLead, { fullName: 'Alice Renamed', isActive: false })).status).toBe(200);
    expect((await a.get(`/api/members/${alice.id}/impact`, fLead)).status).toBe(200);
    expect((await a.del(`/api/members/${alice.id}`, fLead)).status).toBe(204);
  });

  it('the super admin sets a member\'s departments (1–2) and cannot move a leader', async () => {
    const t = buildTestApp();
    const { alice, studio, fintech, superAuth } = await setupOrg(t);
    const a = api(t);
    const third = await createDepartment(t, superAuth, 'Ops');
    expect((await a.patch(`/api/members/${alice.id}`, superAuth, { departmentIds: [studio.id] })).body.data.member.departmentIds).toEqual([studio.id]); // moved
    expect((await a.patch(`/api/members/${alice.id}`, superAuth, { departmentIds: [fintech.id, studio.id] })).body.data.member).toMatchObject({ departmentIds: [fintech.id, studio.id], shared: true });
    expect((await a.patch(`/api/members/${alice.id}`, superAuth, { departmentIds: [fintech.id, studio.id, third.id] })).status).toBe(400); // at most 2
    expect((await a.patch(`/api/members/${alice.id}`, superAuth, { departmentIds: [] })).status).toBe(400); // at least 1
    expect((await a.patch(`/api/members/${alice.id}`, superAuth, { departmentIds: [studio.id, studio.id] })).status).toBe(400); // each once

    const moveLeader = await a.patch(`/api/members/${fintech.leaderId}`, superAuth, { departmentIds: [studio.id] });
    expect(moveLeader.status).toBe(409);
    expect(moveLeader.body.code).toBe('LEADER_DEPARTMENT_LOCKED');
  });
});

describe('tasks: a leader assigns work to their own department\'s members', () => {
  const task = (over: object) => ({ title: 'T', ...over });

  it('creates and assigns within their department; others are refused', async () => {
    const t = buildTestApp();
    const { fintech, studio, alice, carol, fLead, aliceAuth, carolAuth } = await setupOrg(t);
    const a = api(t);
    const ok = await a.post('/api/admin/tasks', fLead, task({ title: 'For Alice', departmentId: fintech.id, memberId: alice.id }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.task).toMatchObject({ departmentName: 'Fintech', memberName: 'Alice A' });
    expect((await a.get('/api/tasks', aliceAuth)).body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Alice']);

    expect((await a.post('/api/admin/tasks', fLead, task({ departmentId: studio.id, memberId: carol.id }))).status).toBe(403); // another department
    expect((await a.post('/api/admin/tasks', fLead, task({ departmentId: fintech.id, memberId: carol.id }))).status).toBe(409); // another department's member
    expect((await a.post('/api/admin/tasks', fLead, task({ departmentId: fintech.id, memberId: t.repos.members.rows.find((m) => m.role === 'ADMIN' && m.departmentIds.includes(fintech.id))!.id }))).status).toBe(403); // a leader can't assign work to themselves
    expect((await a.get('/api/tasks', carolAuth)).body.data.tasks).toEqual([]);
  });

  it("lists only their department's tasks (a ?departmentId= can't widen it) and can't touch another department's task", async () => {
    const t = buildTestApp();
    const { fintech, studio, alice, carol, fLead, sLead, superAuth } = await setupOrg(t);
    const a = api(t);
    await a.post('/api/admin/tasks', fLead, task({ title: 'Fintech task', departmentId: fintech.id, memberId: alice.id }));
    const studioTask = (await a.post('/api/admin/tasks', sLead, task({ title: 'Studio task', departmentId: studio.id, memberId: carol.id }))).body.data.task;

    for (const qs of ['', `?departmentId=${studio.id}`, `?memberId=${carol.id}`]) {
      const res = await a.get(`/api/admin/tasks${qs}`, fLead);
      expect(res.body.data.tasks.map((x: { title: string }) => x.title), qs).toEqual(qs === '' ? ['Fintech task'] : qs.includes('memberId') ? [] : ['Fintech task']);
    }
    expect((await a.patch(`/api/admin/tasks/${studioTask.id}`, fLead, { status: 'DONE' })).status).toBe(404);
    expect((await a.del(`/api/admin/tasks/${studioTask.id}`, fLead)).status).toBe(404);
    const own = (await a.get('/api/admin/tasks', fLead)).body.data.tasks[0];
    expect((await a.patch(`/api/admin/tasks/${own.id}`, fLead, { departmentId: studio.id, memberId: carol.id })).status).toBe(403); // can't hand work to another department
    expect((await a.get('/api/admin/tasks', superAuth)).body.data.tasks).toHaveLength(2); // the super admin sees all
    expect((await a.patch(`/api/admin/tasks/${studioTask.id}`, superAuth, { status: 'DONE' })).status).toBe(200);
  });
});

describe('tasks: assigning to a department LEADER (delegation), not just a member', () => {
  const task = (over: object) => ({ title: 'T', ...over });

  it("a leader hands a task to ANOTHER department's leader: it shows up (read-only) in BOTH the assigner's list and the receiving leader's own", async () => {
    const t = buildTestApp();
    const { studio, fLead, sLead } = await setupOrg(t);
    const a = api(t);
    // No departmentId — it's derived from who the task is for.
    const created = await a.post('/api/admin/tasks', fLead, task({ title: 'For Studio Lead', memberId: studio.leaderId }));
    expect(created.status).toBe(201);
    expect(created.body.data.task).toMatchObject({ departmentId: studio.id, departmentName: 'Studio', memberId: studio.leaderId, memberRole: 'ADMIN' });

    // The assigning leader (Fintech) can still see it — to check whether it's done or still being worked —
    // but managing it (editing/deleting) is the receiving leader's alone: it belongs to Studio now.
    const assignerView = await a.get('/api/admin/tasks', fLead);
    expect(assignerView.body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Studio Lead']);
    expect((await a.patch(`/api/admin/tasks/${created.body.data.task.id}`, fLead, { title: 'x' })).status).toBe(404);

    // The receiving leader (Studio) sees it in their own list.
    const mine = await a.get('/api/admin/tasks', sLead);
    expect(mine.body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Studio Lead']);
  });

  it('the receiving leader can then hand a leader-delegated task to one of their OWN members (an ordinary reassignment)', async () => {
    const t = buildTestApp();
    const { studio, carol, fLead, sLead, carolAuth } = await setupOrg(t);
    const a = api(t);
    const delegated = (await a.post('/api/admin/tasks', fLead, task({ title: 'For Studio Lead', memberId: studio.leaderId }))).body.data.task;

    const reassigned = await a.patch(`/api/admin/tasks/${delegated.id}`, sLead, { memberId: carol.id });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.task).toMatchObject({ departmentId: studio.id, memberId: carol.id, memberRole: 'MEMBER' });
    expect((await a.get('/api/tasks', carolAuth)).body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Studio Lead']);
  });

  it("the assigning leader's read-only view follows what happens to it next — status, and who it ends up with — without exposing anything else of the other department's", async () => {
    const t = buildTestApp();
    const { studio, carol, fLead, sLead } = await setupOrg(t);
    const a = api(t);
    // A task in Studio the Fintech leader had nothing to do with — must stay invisible to them.
    const studioOwn = await a.post('/api/admin/tasks', sLead, task({ title: 'Studio internal', departmentId: studio.id, memberId: carol.id }));
    const delegated = (await a.post('/api/admin/tasks', fLead, task({ title: 'For Studio Lead', memberId: studio.leaderId }))).body.data.task;

    let assignerView = await a.get('/api/admin/tasks', fLead);
    expect(assignerView.body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Studio Lead']); // not "Studio internal"
    expect(assignerView.body.data.tasks[0]).toMatchObject({ status: 'TODO', memberRole: 'ADMIN' });

    // The receiving leader starts working it, then hands it to Carol, who finishes it.
    await a.patch(`/api/admin/tasks/${delegated.id}`, sLead, { status: 'IN_PROGRESS' });
    assignerView = await a.get('/api/admin/tasks', fLead);
    expect(assignerView.body.data.tasks[0]).toMatchObject({ status: 'IN_PROGRESS', memberName: 'Studio Leader' });

    await a.patch(`/api/admin/tasks/${delegated.id}`, sLead, { memberId: carol.id, status: 'DONE' });
    assignerView = await a.get('/api/admin/tasks', fLead);
    expect(assignerView.body.data.tasks[0]).toMatchObject({ status: 'DONE', memberName: 'Carol C', memberRole: 'MEMBER' });
    expect((await a.get('/api/admin/tasks', fLead)).body.data.tasks).toHaveLength(1); // still only the one they delegated
    expect(studioOwn.status).toBe(201);
  });

  it("a leader still can't hand work directly to ANOTHER department's MEMBER — only to its leader", async () => {
    const t = buildTestApp();
    const { studio, carol, fLead } = await setupOrg(t);
    const a = api(t);
    expect((await a.post('/api/admin/tasks', fLead, task({ departmentId: studio.id, memberId: carol.id }))).status).toBe(403);
    const noDept = await a.post('/api/admin/tasks', fLead, task({ memberId: carol.id })); // omitting departmentId only works for a leader target
    expect(noDept.status).toBe(400);
    expect(noDept.body.code).toBe('DEPARTMENT_REQUIRED');
  });

  it('the super admin assigns directly to any leader, in any department', async () => {
    const t = buildTestApp();
    const { fintech, studio, superAuth, sLead } = await setupOrg(t);
    const a = api(t);
    const toFintechLead = await a.post('/api/admin/tasks', superAuth, task({ title: 'For Fintech Lead', memberId: fintech.leaderId }));
    expect(toFintechLead.status).toBe(201);
    expect(toFintechLead.body.data.task).toMatchObject({ departmentId: fintech.id, memberId: fintech.leaderId, memberRole: 'ADMIN' });

    const toStudioLead = await a.post('/api/admin/tasks', superAuth, task({ title: 'For Studio Lead', memberId: studio.leaderId }));
    expect(toStudioLead.status).toBe(201);
    expect(toStudioLead.body.data.task.departmentId).toBe(studio.id);
    expect((await a.get('/api/admin/tasks', sLead)).body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['For Studio Lead']);
  });

  it('every task carries memberRole, for a plain member too', async () => {
    const t = buildTestApp();
    const { fintech, alice, fLead } = await setupOrg(t);
    const a = api(t);
    const res = await a.post('/api/admin/tasks', fLead, task({ departmentId: fintech.id, memberId: alice.id }));
    expect(res.body.data.task.memberRole).toBe('MEMBER');
  });

  it('createdByName resolves to "Super Admin" or the assigning leader\'s own name', async () => {
    const t = buildTestApp();
    const { fintech, studio, superAuth, fLead } = await setupOrg(t);
    const a = api(t);
    const bySuper = await a.post('/api/admin/tasks', superAuth, task({ memberId: studio.leaderId }));
    expect(bySuper.body.data.task).toMatchObject({ createdBy: t.env.ADMIN_USERNAME, createdByName: 'Super Admin' });
    const byLeader = await a.post('/api/admin/tasks', fLead, task({ departmentId: fintech.id, memberId: (await a.get('/api/members', fLead)).body.data.members[0].id }));
    expect(byLeader.body.data.task).toMatchObject({ createdByName: 'Fintech Leader' });
  });

  it("a leader works a task assigned directly to them exactly like a member does theirs: For You, timer, log time, status — while their admin-side scoping is untouched", async () => {
    const t = buildTestApp();
    const { fintech, studio, superAuth, fLead, sLead } = await setupOrg(t);
    const a = api(t);
    const assigned = (await a.post('/api/admin/tasks', superAuth, task({ title: 'For Studio Lead', memberId: studio.leaderId }))).body.data.task;

    // Their own "For You" — the same route and shape a member's tasks come through.
    const mine = await a.get('/api/tasks', sLead);
    expect(mine.status).toBe(200);
    expect(mine.body.data.tasks).toHaveLength(1);
    expect(mine.body.data.tasks[0]).toMatchObject({ id: assigned.id, createdByName: 'Super Admin' });

    // Timer: start, and Time Tracker "today" — the exact self-service a member has.
    expect((await a.post(`/api/tasks/${assigned.id}/timer`, sLead)).status).toBe(200);
    expect((await a.get('/api/time-tracker/today', sLead)).status).toBe(200);
    t.clock.advanceMinutes(30);
    const logged = await a.post('/api/time-tracker', sLead, { category: 'WORK', durationMinutes: 20, taskId: assigned.id });
    expect(logged.status).toBe(201);
    expect((await a.get('/api/tasks', sLead)).body.data.tasks[0].loggedMinutes).toBe(20);

    // Status, like a member reporting their own progress.
    expect((await a.patch(`/api/tasks/${assigned.id}/status`, sLead, { status: 'DONE' })).status).toBe(200);

    // Their admin-side department scoping is exactly as before: still only Studio.
    expect((await a.get('/api/departments', sLead)).body.data.departments.map((d: { id: string }) => d.id)).toEqual([studio.id]);
    // Someone else's own task is still refused, same as a member's would be.
    const fintechTask = (await a.post('/api/admin/tasks', fLead, task({ title: 'Own', departmentId: fintech.id, memberId: (await a.get('/api/members', fLead)).body.data.members[0].id }))).body.data.task;
    expect((await a.patch(`/api/tasks/${fintechTask.id}/status`, sLead, { status: 'DONE' })).status).toBe(404);

    // Their own logged time shows up in their own Activity History report too, alongside their department's members.
    const history = await a.get('/api/admin/time-tracker/history?date=2026-09-21', sLead);
    expect(history.status).toBe(200);
    expect(history.body.data.entries.some((e: { memberId: string; entryType: string }) => e.memberId === studio.leaderId && e.entryType === 'TRACKER')).toBe(true);
  });
});

describe('time tracker: a leader reads and corrects only their own department\'s members', () => {
  async function withEntries() {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const org = await setupOrg(t);
    const a = api(t);
    const log = async (auth: string, category: string) => (await a.post('/api/time-tracker', auth, { category, durationMinutes: 30 })).body.data.entries[0].trackerId as string;
    return { t, a, ...org, aliceEntry: await log(org.aliceAuth, 'WORK'), carolEntry: await log(org.carolAuth, 'LEARNING') };
  }

  it("the overview, a member's day and the history exclude other departments, whatever the filters say", async () => {
    const { a, fLead, superAuth, alice, bob, carol, studio } = await withEntries();
    expect((await a.get('/api/admin/time-tracker', fLead)).body.data.members.map((m: { memberId: string }) => m.memberId).sort()).toEqual([alice.id, bob.id].sort());
    expect((await a.get(`/api/admin/time-tracker/members/${carol.id}`, fLead)).status).toBe(404);
    expect((await a.get(`/api/admin/time-tracker/members/${alice.id}`, fLead)).status).toBe(200);

    for (const qs of ['', `&departmentId=${studio.id}`, `&memberId=${carol.id}`]) {
      const res = await a.get(`/api/admin/time-tracker/history?date=2026-09-22${qs}`, fLead);
      expect(res.status).toBe(200);
      expect(new Set(res.body.data.entries.map((e: { memberName: string }) => e.memberName)), qs).toEqual(qs.includes('memberId') ? new Set() : new Set(['Alice A']));
    }
    const all = await a.get('/api/admin/time-tracker/history?date=2026-09-22', superAuth);
    expect(new Set(all.body.data.entries.map((e: { memberName: string }) => e.memberName))).toEqual(new Set(['Alice A', 'Carol C']));
    expect((await a.get('/api/admin/time-tracker', superAuth)).body.data.members).toHaveLength(3); // 3 members, no leaders
  });

  it("can open, edit and delete their members' entries, but another department's entries are 'not found'", async () => {
    const { a, fLead, superAuth, aliceEntry, carolEntry } = await withEntries();
    expect((await a.get(`/api/admin/time-tracker/${aliceEntry}`, fLead)).status).toBe(200);
    expect((await a.patch(`/api/admin/time-tracker/${aliceEntry}`, fLead, { category: 'WORK', durationMinutes: 20 })).status).toBe(200);

    expect((await a.get(`/api/admin/time-tracker/${carolEntry}`, fLead)).status).toBe(404);
    expect((await a.patch(`/api/admin/time-tracker/${carolEntry}`, fLead, { category: 'WORK', durationMinutes: 5 })).status).toBe(404);
    expect((await a.del(`/api/admin/time-tracker/${carolEntry}`, fLead)).status).toBe(404);
    expect((await a.del(`/api/admin/time-tracker/${carolEntry}`, superAuth)).status).toBe(200); // the super admin can

    expect((await a.del(`/api/admin/time-tracker/${aliceEntry}`, fLead)).status).toBe(200);
  });

  it('a member cannot read a teammate\'s ledger by id', async () => {
    const { a, bobAuth, aliceEntry } = await withEntries();
    expect((await a.get(`/api/time-tracker/${aliceEntry}`, bobAuth)).status).toBe(404);
    expect((await a.patch(`/api/time-tracker/${aliceEntry}`, bobAuth, { category: 'WORK', durationMinutes: 5 })).status).toBe(404);
    expect((await a.get(`/api/admin/time-tracker/${aliceEntry}`, bobAuth)).status).toBe(403);
  });
});

describe('team: what a member may know about their own department', () => {
  it('shows the department, its leader and the teammates — names only', async () => {
    const t = buildTestApp();
    const { fintech, aliceAuth, carolAuth } = await setupOrg(t);
    const a = api(t);
    const res = await a.get('/api/team', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([
      {
        department: { id: fintech.id, name: 'Fintech' },
        leader: { id: fintech.leaderId, fullName: 'Fintech Leader' },
        members: [
          { id: expect.any(String), fullName: 'Alice A', isYou: true },
          { id: expect.any(String), fullName: 'Bob B', isYou: false },
        ],
      },
    ]);
    // nothing private: no emails, no other department
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com|Carol|Studio|passwordHash/);
    expect((await a.get('/api/team', carolAuth)).body.data.teams[0].members).toEqual([{ id: expect.any(String), fullName: 'Carol C', isYou: true }]);
    expect((await a.get('/api/team')).status).toBe(401);
  });
});

describe('cross-department requests', () => {
  const send = (t: TestApp, auth: string, body: object) => request(t.app).post('/api/requests').set('Authorization', auth).send(body);

  it("a member sends a request to ANOTHER department's leader, who sees it in their inbox and answers it", async () => {
    const t = buildTestApp();
    const { studio, fintech, aliceAuth, sLead, fLead } = await setupOrg(t);
    const a = api(t);

    const targets = await a.get('/api/requests/targets', aliceAuth);
    // every department with a leader — their own first
    expect(targets.body.data.targets).toEqual([
      { departmentId: fintech.id, departmentName: 'Fintech', leaderName: 'Fintech Leader', isOwnDepartment: true },
      { departmentId: studio.id, departmentName: 'Studio', leaderName: 'Studio Leader', isOwnDepartment: false },
    ]);

    const sent = await send(t, aliceAuth, { toDepartmentId: studio.id, subject: '  Need a banner  ', message: 'Two banner designs by Friday, please.' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.request).toMatchObject({ subject: 'Need a banner', status: 'OPEN', toDepartmentName: 'Studio', toLeaderName: 'Studio Leader', response: null });

    const inbox = await a.get('/api/admin/requests', sLead);
    expect(inbox.body.data.requests).toHaveLength(1);
    expect(inbox.body.data.requests[0]).toMatchObject({ fromMemberName: 'Alice A', fromDepartments: [{ id: fintech.id, name: 'Fintech' }], toDepartmentName: 'Studio', message: 'Two banner designs by Friday, please.' });
    expect((await a.get('/api/admin/requests', fLead)).body.data.requests).toEqual([]); // not the sender's own leader

    const requestId = inbox.body.data.requests[0].id;
    const answered = await a.patch(`/api/admin/requests/${requestId}`, sLead, { status: 'IN_PROGRESS', response: '  On it — Carol will do it.  ' });
    expect(answered.status).toBe(200);
    expect(answered.body.data.request).toMatchObject({ status: 'IN_PROGRESS', response: 'On it — Carol will do it.' });

    const mine = await a.get('/api/requests', aliceAuth);
    expect(mine.body.data.requests[0]).toMatchObject({ status: 'IN_PROGRESS', response: 'On it — Carol will do it.' });
    expect((await a.get('/api/admin/requests?status=DONE', sLead)).body.data.requests).toEqual([]);
    expect((await a.get('/api/admin/requests?status=IN_PROGRESS', sLead)).body.data.requests).toHaveLength(1);
    expect(fintech.id).not.toBe(studio.id);
  });

  it('accepts your own leader too; rejects an unknown department, one with no leader, a disabled leader — and validates', async () => {
    const t = buildTestApp();
    const { superAuth, fintech, studio, aliceAuth } = await setupOrg(t);
    const a = api(t);
    const body = { subject: 'S', message: 'M' };
    const own = await send(t, aliceAuth, { ...body, toDepartmentId: fintech.id }); // her own department's leader
    expect(own.status).toBe(201);
    expect(own.body.data.request).toMatchObject({ toDepartmentName: 'Fintech', toLeaderName: 'Fintech Leader' });
    expect((await a.get('/api/admin/requests', await loginLeader(t, 'Fintech'))).body.data.requests).toHaveLength(1); // …who receives it
    expect((await send(t, aliceAuth, { ...body, toDepartmentId: UNKNOWN_ID })).status).toBe(404);

    const legacy = await t.repos.departments.create({ name: 'Legacy' });
    const noLeader = await send(t, aliceAuth, { ...body, toDepartmentId: legacy.id });
    expect(noLeader.status).toBe(409);
    expect(noLeader.body.code).toBe('DEPARTMENT_NO_LEADER');
    expect((await a.get('/api/requests/targets', aliceAuth)).body.data.targets.map((x: { departmentName: string }) => x.departmentName)).toEqual(['Fintech', 'Studio']); // (Legacy has no leader)

    for (const bad of [{ toDepartmentId: studio.id, subject: '', message: 'M' }, { toDepartmentId: studio.id, subject: 'S', message: '   ' }, { toDepartmentId: 'nope', subject: 'S', message: 'M' }, { subject: 'S', message: 'M' }, { toDepartmentId: studio.id, subject: 'S'.repeat(201), message: 'M' }]) {
      expect((await send(t, aliceAuth, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(t.repos.requests.rows).toHaveLength(1); // only the valid one above

    // a disabled leader can't receive; neither can a deactivated department
    await a.patch(`/api/members/${studio.leaderId}`, superAuth, { isActive: false });
    expect((await send(t, aliceAuth, { ...body, toDepartmentId: studio.id })).status).toBe(409);
    expect((await a.get('/api/requests/targets', aliceAuth)).body.data.targets.map((x: { departmentName: string }) => x.departmentName)).toEqual(['Fintech']);
  });

  it("people only ever see their own side: a member sees only their own requests, a leader only their department's", async () => {
    const t = buildTestApp();
    const { studio, fintech, aliceAuth, bobAuth, carolAuth, sLead, fLead, superAuth } = await setupOrg(t);
    const a = api(t);
    const toStudio = (await send(t, aliceAuth, { toDepartmentId: studio.id, subject: 'A→S', message: 'm' })).body.data.request;
    const toFintech = (await send(t, carolAuth, { toDepartmentId: fintech.id, subject: 'C→F', message: 'm' })).body.data.request;

    expect((await a.get('/api/requests', bobAuth)).body.data.requests).toEqual([]); // a teammate's request isn't theirs
    expect((await a.get('/api/requests', aliceAuth)).body.data.requests.map((r: { subject: string }) => r.subject)).toEqual(['A→S']);
    expect((await a.get('/api/admin/requests', sLead)).body.data.requests.map((r: { subject: string }) => r.subject)).toEqual(['A→S']);
    expect((await a.get('/api/admin/requests', fLead)).body.data.requests.map((r: { subject: string }) => r.subject)).toEqual(['C→F']);
    expect((await a.get('/api/admin/requests', superAuth)).body.data.requests).toHaveLength(2);

    // a leader can't read or change the other department's inbox
    expect((await a.patch(`/api/admin/requests/${toStudio.id}`, fLead, { status: 'DONE' })).status).toBe(404);
    expect((await a.patch(`/api/admin/requests/${toFintech.id}`, sLead, { status: 'DONE' })).status).toBe(404);
    expect((await a.patch(`/api/admin/requests/${UNKNOWN_ID}`, sLead, { status: 'DONE' })).status).toBe(404);
    // …and members can't touch the inbox at all
    expect((await a.patch(`/api/admin/requests/${toStudio.id}`, aliceAuth, { status: 'DONE' })).status).toBe(403);
    expect(t.repos.requests.rows.every((r) => r.status === 'OPEN')).toBe(true);
    // the super admin can manage any
    expect((await a.patch(`/api/admin/requests/${toStudio.id}`, superAuth, { status: 'DECLINED', response: 'No.' })).status).toBe(200);
    expect((await a.patch(`/api/admin/requests/${toStudio.id}`, sLead, {})).status).toBe(400);
  });

  it("deleting the sender or the receiving department removes the request with them", async () => {
    const t = buildTestApp();
    const { superAuth, studio, alice, aliceAuth } = await setupOrg(t);
    const a = api(t);
    await send(t, aliceAuth, { toDepartmentId: studio.id, subject: 'x', message: 'm' });
    await a.del(`/api/members/${alice.id}`, superAuth);
    expect(t.repos.requests.rows).toHaveLength(0);
  });
});

describe('cross-department requests: an ongoing conversation, after the first exchange', () => {
  const send = (t: TestApp, auth: string, body: object) => request(t.app).post('/api/requests').set('Authorization', auth).send(body);

  it('either side can keep adding messages, in order, each with who sent it', async () => {
    const t = buildTestApp();
    const { studio, aliceAuth, sLead, superAuth } = await setupOrg(t);
    const a = api(t);
    const id = (await send(t, aliceAuth, { toDepartmentId: studio.id, subject: 'Need a banner', message: 'Two designs please.' })).body.data.request.id;
    await a.patch(`/api/admin/requests/${id}`, sLead, { status: 'IN_PROGRESS', response: 'On it.' });

    const m1 = await a.post(`/api/requests/${id}/messages`, aliceAuth, { body: '  Any update?  ' });
    expect(m1.status).toBe(201);
    expect(m1.body.data.request.messages).toEqual([{ id: expect.any(String), authorRole: 'member', authorName: 'Alice A', body: 'Any update?', createdAt: expect.any(String) }]);

    const m2 = await a.post(`/api/admin/requests/${id}/messages`, sLead, { body: 'Almost done, tomorrow.' });
    expect(m2.status).toBe(201);
    const m3 = await a.post(`/api/admin/requests/${id}/messages`, superAuth, { body: 'Let me know if you need a hand.' });
    expect(m3.status).toBe(201);

    const mine = (await a.get('/api/requests', aliceAuth)).body.data.requests[0];
    expect(mine.messages.map((x: { authorRole: string; authorName: string; body: string }) => [x.authorRole, x.authorName, x.body])).toEqual([
      ['member', 'Alice A', 'Any update?'],
      ['admin', 'Studio Leader', 'Almost done, tomorrow.'],
      ['super_admin', 'Super Admin', 'Let me know if you need a hand.'],
    ]);
    // the receiving leader and the super admin see the exact same thread
    const inbox = (await a.get('/api/admin/requests', sLead)).body.data.requests[0];
    expect(inbox.messages).toEqual(mine.messages);
  });

  it("a member can't message someone else's request; a leader/super admin can't message one outside their scope; blank/oversized is rejected; signed out is refused", async () => {
    const t = buildTestApp();
    const { studio, fintech, aliceAuth, bobAuth, fLead, sLead } = await setupOrg(t);
    const a = api(t);
    const id = (await send(t, aliceAuth, { toDepartmentId: studio.id, subject: 'x', message: 'm' })).body.data.request.id;

    expect((await a.post(`/api/requests/${id}/messages`, bobAuth, { body: 'x' })).status).toBe(404); // not my request
    expect((await a.post(`/api/admin/requests/${id}/messages`, fLead, { body: 'x' })).status).toBe(404); // not addressed to my department
    expect((await a.post(`/api/requests/${id}/messages`, aliceAuth, { body: '   ' })).status).toBe(400);
    expect((await a.post(`/api/requests/${id}/messages`, aliceAuth, { body: 'x'.repeat(2001) })).status).toBe(400);
    expect((await request(t.app).post(`/api/requests/${id}/messages`).send({ body: 'x' })).status).toBe(401);
    void fintech, sLead;
  });

  it("a member's message is refused once the request is DONE or DECLINED, but the leader/super admin can still add one", async () => {
    const t = buildTestApp();
    const { studio, aliceAuth, sLead, superAuth } = await setupOrg(t);
    const a = api(t);
    const id = (await send(t, aliceAuth, { toDepartmentId: studio.id, subject: 'x', message: 'm' })).body.data.request.id;
    await a.patch(`/api/admin/requests/${id}`, sLead, { status: 'DONE' });

    const blocked = await a.post(`/api/requests/${id}/messages`, aliceAuth, { body: 'thanks!' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('REQUEST_CLOSED');

    expect((await a.post(`/api/admin/requests/${id}/messages`, sLead, { body: 'Closing this out.' })).status).toBe(201);
    expect((await a.post(`/api/admin/requests/${id}/messages`, superAuth, { body: 'Noted.' })).status).toBe(201);
  });
});
