import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, loginLeader, type TestApp } from './helpers/test-app';

const LOCAL_MIDNIGHT_UTC = '2026-09-21T18:30:00.000Z'; // local midnight of 2026-09-22 IST
const UNKNOWN_ID = '0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11';

const api = (t: TestApp) => ({
  get: (path: string, auth?: string) => (auth ? request(t.app).get(path).set('Authorization', auth) : request(t.app).get(path)),
  post: (path: string, auth: string, body: object = {}) => request(t.app).post(path).set('Authorization', auth).send(body),
  patch: (path: string, auth: string, body: object) => request(t.app).patch(path).set('Authorization', auth).send(body),
  del: (path: string, auth: string) => request(t.app).delete(path).set('Authorization', auth),
});

/**
 * Fintech (leader, alice, bob), Studio (leader, carol), Ops (leader only) — and DAVE, who belongs to BOTH
 * Fintech and Studio. The clock is an hour past local midnight so time can be logged.
 */
async function setupOrg() {
  const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
  t.clock.advanceMinutes(60);
  const superAuth = await loginAdmin(t);
  const fintech = await createDepartment(t, superAuth, 'Fintech');
  const studio = await createDepartment(t, superAuth, 'Studio');
  const ops = await createDepartment(t, superAuth, 'Ops');
  const mk = (username: string, name: string, departmentIds: string[]) => createMember(t, superAuth, { username: `${username}@example.com`, fullName: name, password: `${username}-pass`, departmentIds });
  const alice = await mk('alice', 'Alice A', [fintech.id]);
  const bob = await mk('bob', 'Bob B', [fintech.id]);
  const carol = await mk('carol', 'Carol C', [studio.id]);
  const dave = await mk('dave', 'Dave D', [fintech.id, studio.id]);
  return {
    t,
    a: api(t),
    superAuth,
    fintech,
    studio,
    ops,
    alice,
    bob,
    carol,
    dave,
    fLead: await loginLeader(t, 'Fintech'),
    sLead: await loginLeader(t, 'Studio'),
    oLead: await loginLeader(t, 'Ops'),
    aliceAuth: await login(t, 'alice@example.com', 'alice-pass'),
    carolAuth: await login(t, 'carol@example.com', 'carol-pass'),
    daveAuth: await login(t, 'dave@example.com', 'dave-pass'),
  };
}

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('a member can belong to up to two departments', () => {
  it('accepts 1 or 2 distinct, active departments — and refuses 0, 3, duplicates, unknown and inactive ones', async () => {
    const { t, a, superAuth, fintech, studio, ops } = await setupOrg();
    const body = (n: string, departmentIds: unknown) => ({ username: `${n}@example.com`, fullName: n, password: 'pw-pw-pw', departmentIds });

    const two = await a.post('/api/members', superAuth, body('two', [fintech.id, studio.id]));
    expect(two.status).toBe(201);
    expect(two.body.data.member).toMatchObject({ departmentIds: [fintech.id, studio.id], shared: true, role: 'MEMBER' });
    expect((await a.post('/api/members', superAuth, body('one', [ops.id]))).body.data.member.shared).toBe(false);

    for (const [name, bad] of [['none', []], ['three', [fintech.id, studio.id, ops.id]], ['dup', [fintech.id, fintech.id]], ['junk', ['nope']], ['missing', undefined]] as const) {
      expect((await a.post('/api/members', superAuth, body(name, bad))).status, name).toBe(400);
    }
    expect((await a.post('/api/members', superAuth, body('ghost', [UNKNOWN_ID]))).status).toBe(404);

    const dormant = await createDepartment(t, superAuth, 'Dormant'); // nobody in it yet, so it can be deactivated
    expect((await a.patch(`/api/departments/${dormant.id}`, superAuth, { isActive: false })).status).toBe(200);
    const inactive = await a.post('/api/members', superAuth, body('late', [fintech.id, dormant.id]));
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('DEPARTMENT_INACTIVE');
    expect(t.repos.members.rows.some((m) => ['none', 'three', 'dup', 'junk', 'missing', 'ghost', 'late'].some((n) => m.username === `${n}@example.com`))).toBe(false);
  });

  it('the storage layer refuses a third department too (like the database trigger)', async () => {
    const { t, dave, ops } = await setupOrg();
    await expect(t.repos.members.update(dave.id, { departmentIds: [dave.departmentIds[0]!, dave.departmentIds[1]!, ops.id] })).rejects.toMatchObject({ code: 'TOO_MANY_DEPARTMENTS' });
  });
});

describe('both leaders see the shared member — each only their own side', () => {
  it("lists dave for BOTH leaders, but never tells a leader which OTHER department he is in", async () => {
    const { a, fLead, sLead, fintech, studio, dave, superAuth } = await setupOrg();
    const f = (await a.get('/api/members', fLead)).body.data.members;
    const s = (await a.get('/api/members', sLead)).body.data.members;
    expect(idsOf(f)).toContain(dave.id);
    expect(idsOf(s)).toContain(dave.id);
    expect(f.find((m: { id: string }) => m.id === dave.id)).toMatchObject({ departmentIds: [fintech.id], shared: true });
    expect(s.find((m: { id: string }) => m.id === dave.id)).toMatchObject({ departmentIds: [studio.id], shared: true });
    expect(JSON.stringify(f)).not.toContain(studio.id);
    expect(JSON.stringify(s)).not.toContain(fintech.id);
    expect((await a.get('/api/members', superAuth)).body.data.members.find((m: { id: string }) => m.id === dave.id).departmentIds).toEqual([fintech.id, studio.id]);
  });

  it("a leader can't edit, delete or read the impact of a shared member (the super admin can) — but can still edit an exclusive one", async () => {
    const { a, fLead, dave, alice, superAuth } = await setupOrg();
    for (const res of [await a.patch(`/api/members/${dave.id}`, fLead, { fullName: 'Hacked' }), await a.patch(`/api/members/${dave.id}`, fLead, { isActive: false }), await a.del(`/api/members/${dave.id}`, fLead), await a.get(`/api/members/${dave.id}/impact`, fLead)]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MEMBER_SHARED');
    }
    expect((await a.patch(`/api/members/${alice.id}`, fLead, { fullName: 'Alice Renamed' })).status).toBe(200);
    expect((await a.patch(`/api/members/${dave.id}`, superAuth, { fullName: 'Dave Renamed' })).status).toBe(200);
  });
});

describe('tasks across both departments', () => {
  it("a shared member sees the tasks of BOTH departments in For You; each leader manages only their own department's", async () => {
    const { a, fLead, sLead, fintech, studio, dave, aliceAuth, carolAuth, daveAuth } = await setupOrg();
    const fTask = (await a.post('/api/admin/tasks', fLead, { title: 'Fintech report', departmentId: fintech.id, memberId: dave.id })).body.data.task;
    const sTask = (await a.post('/api/admin/tasks', sLead, { title: 'Studio banner', departmentId: studio.id, memberId: dave.id })).body.data.task;
    expect(fTask.departmentName).toBe('Fintech');
    expect(sTask.departmentName).toBe('Studio');

    const forYou = (await a.get('/api/tasks', daveAuth)).body.data.tasks;
    expect(forYou.map((t: { title: string }) => t.title).sort()).toEqual(['Fintech report', 'Studio banner']);
    expect(forYou.map((t: { departmentName: string }) => t.departmentName).sort()).toEqual(['Fintech', 'Studio']);
    // nobody else sees them
    expect((await a.get('/api/tasks', aliceAuth)).body.data.tasks).toEqual([]);
    expect((await a.get('/api/tasks', carolAuth)).body.data.tasks).toEqual([]);

    // each leader's list, and their power over the other department's task
    expect((await a.get('/api/admin/tasks', fLead)).body.data.tasks.map((t: { title: string }) => t.title)).toEqual(['Fintech report']);
    expect((await a.get('/api/admin/tasks', sLead)).body.data.tasks.map((t: { title: string }) => t.title)).toEqual(['Studio banner']);
    expect((await a.patch(`/api/admin/tasks/${sTask.id}`, fLead, { status: 'DONE' })).status).toBe(404);
    expect((await a.del(`/api/admin/tasks/${fTask.id}`, sLead)).status).toBe(404);

  });

  it('a leader cannot assign a shared member work in a department they do not lead, and a member only gets tasks of their own departments', async () => {
    const { a, fLead, superAuth, fintech, studio, ops, dave, carol } = await setupOrg();
    expect((await a.post('/api/admin/tasks', fLead, { title: 'X', departmentId: studio.id, memberId: dave.id })).status).toBe(403); // not their department
    expect((await a.post('/api/admin/tasks', superAuth, { title: 'X', departmentId: ops.id, memberId: dave.id })).status).toBe(409); // dave isn't in Ops
    expect((await a.post('/api/admin/tasks', superAuth, { title: 'X', departmentId: fintech.id, memberId: carol.id })).status).toBe(409); // carol isn't in Fintech
    expect((await a.post('/api/admin/tasks', superAuth, { title: 'ok', departmentId: studio.id, memberId: dave.id })).status).toBe(201);
  });

  it('time is logged against either task through the normal tracker — the ledger maths is exactly the same', async () => {
    const { t, a, fLead, sLead, fintech, studio, dave, daveAuth } = await setupOrg();
    const fTask = (await a.post('/api/admin/tasks', fLead, { title: 'Fintech report', departmentId: fintech.id, memberId: dave.id })).body.data.task;
    const sTask = (await a.post('/api/admin/tasks', sLead, { title: 'Studio banner', departmentId: studio.id, memberId: dave.id })).body.data.task;

    const first = await a.post('/api/time-tracker', daveAuth, { category: 'WORK', durationMinutes: 40, taskId: fTask.id }); // 60-minute window: 40 tracked + 20 gap
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ totals: { WORK: 40, BASE: 20 }, usedMinutes: 60 });
    // …and a later entry on the OTHER department's task follows the same rule (window since the previous entry)
    t.clock.advanceMinutes(30);
    const second = await a.post('/api/time-tracker', daveAuth, { category: 'WORK', durationMinutes: 25, taskId: sTask.id }); // 30-minute window: 25 tracked + 5 gap
    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({ totals: { WORK: 65, BASE: 25 }, usedMinutes: 90 });
    const tasks = (await a.get('/api/tasks', daveAuth)).body.data.tasks;
    expect(tasks.find((x: { id: string }) => x.id === fTask.id)).toMatchObject({ loggedMinutes: 40, status: 'IN_PROGRESS' });
    expect(tasks.find((x: { id: string }) => x.id === sTask.id)).toMatchObject({ loggedMinutes: 25, status: 'IN_PROGRESS' });
  });
});

describe("a leader's view of a shared member's time", () => {
  it('both leaders can READ his day and history; only the super admin can CHANGE the entries of a shared member', async () => {
    const { a, fLead, sLead, superAuth, dave, alice, aliceAuth, daveAuth } = await setupOrg();
    const daveEntry = (await a.post('/api/time-tracker', daveAuth, { category: 'WORK', durationMinutes: 30 })).body.data.entries[0].trackerId as string;
    const aliceEntry = (await a.post('/api/time-tracker', aliceAuth, { category: 'LEARNING', durationMinutes: 30 })).body.data.entries[0].trackerId as string;

    for (const lead of [fLead, sLead]) {
      expect((await a.get(`/api/admin/time-tracker/members/${dave.id}`, lead)).status).toBe(200);
      expect((await a.get(`/api/admin/time-tracker/${daveEntry}`, lead)).status).toBe(200);
      const history = await a.get('/api/admin/time-tracker/history?date=2026-09-22', lead);
      expect(new Set(history.body.data.entries.map((e: { memberName: string }) => e.memberName)).has('Dave D')).toBe(true);
    }
    // a shared member's entries can carry another department's work → a leader may not change them
    for (const res of [await a.patch(`/api/admin/time-tracker/${daveEntry}`, fLead, { category: 'WORK', durationMinutes: 20 }), await a.del(`/api/admin/time-tracker/${daveEntry}`, sLead)]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MEMBER_SHARED');
    }
    expect((await a.patch(`/api/admin/time-tracker/${daveEntry}`, superAuth, { category: 'WORK', durationMinutes: 20 })).status).toBe(200);
    // …while an exclusive member's entries stay editable by their one leader, and only by theirs
    expect((await a.patch(`/api/admin/time-tracker/${aliceEntry}`, fLead, { category: 'LEARNING', durationMinutes: 20 })).status).toBe(200);
    expect((await a.patch(`/api/admin/time-tracker/${aliceEntry}`, sLead, { category: 'LEARNING', durationMinutes: 10 })).status).toBe(404);
    expect(alice.id).not.toBe(dave.id);
  });
});

describe('teams and requests for a member in two departments', () => {
  it('the team page shows BOTH departments — each with its leader and members — and nothing else', async () => {
    const { a, fintech, studio, daveAuth, aliceAuth } = await setupOrg();
    const teams = (await a.get('/api/team', daveAuth)).body.data.teams;
    expect(teams.map((x: { department: { name: string } }) => x.department.name)).toEqual(['Fintech', 'Studio']);
    const fintechTeam = teams.find((x: { department: { id: string } }) => x.department.id === fintech.id);
    const studioTeam = teams.find((x: { department: { id: string } }) => x.department.id === studio.id);
    expect(fintechTeam.leader.fullName).toBe('Fintech Leader');
    expect(fintechTeam.members.map((m: { fullName: string }) => m.fullName)).toEqual(['Alice A', 'Bob B', 'Dave D']);
    expect(studioTeam.members.map((m: { fullName: string }) => m.fullName)).toEqual(['Carol C', 'Dave D']);
    expect(studioTeam.members.find((m: { isYou: boolean }) => m.isYou).fullName).toBe('Dave D');
    expect(JSON.stringify(teams)).not.toMatch(/@example\.com|Ops|passwordHash/);

    const alice = (await a.get('/api/team', aliceAuth)).body.data.teams;
    expect(alice).toHaveLength(1); // alice sees only Fintech — and dave in it
    expect(alice[0].members.map((m: { fullName: string }) => m.fullName)).toContain('Dave D');
    expect(JSON.stringify(alice)).not.toContain('Studio');
  });

  it("requests: he can ask the leader of EITHER of his own departments or any other; the receiving leader sees all his departments", async () => {
    const { a, ops, fintech, studio, oLead, fLead, sLead, daveAuth } = await setupOrg();
    const targets = (await a.get('/api/requests/targets', daveAuth)).body.data.targets;
    expect(targets.map((x: { departmentName: string; isOwnDepartment: boolean }) => [x.departmentName, x.isOwnDepartment])).toEqual([['Fintech', true], ['Studio', true], ['Ops', false]]); // his own first
    for (const own of [fintech, studio]) {
      expect((await a.post('/api/requests', daveAuth, { toDepartmentId: own.id, subject: `To ${own.name}`, message: 'M' })).status).toBe(201);
    }
    expect((await a.get('/api/admin/requests', fLead)).body.data.requests.map((r: { subject: string }) => r.subject)).toEqual(['To Fintech']);
    expect((await a.get('/api/admin/requests', sLead)).body.data.requests.map((r: { subject: string }) => r.subject)).toEqual(['To Studio']); // each leader gets only theirs
    const sent = await a.post('/api/requests', daveAuth, { toDepartmentId: ops.id, subject: 'Need a laptop', message: 'Please.' });
    expect(sent.status).toBe(201);

    const inbox = (await a.get('/api/admin/requests', oLead)).body.data.requests;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].fromDepartments.map((d: { name: string }) => d.name).sort()).toEqual(['Fintech', 'Studio']);
    expect(inbox[0].fromMemberName).toBe('Dave D');
    // convert it into a task for the Ops leader's own members: Ops has none yet, so they'd add one first — the leader can reply meanwhile
    expect((await a.patch(`/api/admin/requests/${inbox[0].id}`, oLead, { status: 'DONE', response: 'Ordered.' })).status).toBe(200);
    expect((await a.get('/api/requests', daveAuth)).body.data.requests.find((r: { subject: string }) => r.subject === 'Need a laptop')).toMatchObject({ status: 'DONE', response: 'Ordered.' });
  });
});

describe('deleting a department when members belong to two', () => {
  it("removes its leader, its exclusive members and its tasks — but a member who is also elsewhere stays, with his other department untouched", async () => {
    const { t, a, superAuth, fLead, sLead, fintech, studio, alice, carol, dave, aliceAuth, daveAuth } = await setupOrg();
    const sTask = (await a.post('/api/admin/tasks', sLead, { title: 'Studio banner', departmentId: studio.id, memberId: dave.id })).body.data.task;
    const fTask = (await a.post('/api/admin/tasks', fLead, { title: 'Fintech report', departmentId: fintech.id, memberId: dave.id })).body.data.task;
    await a.post('/api/admin/tasks', sLead, { title: "Carol's task", departmentId: studio.id, memberId: carol.id });
    await a.post('/api/admin/tasks', fLead, { title: "Alice's task", departmentId: fintech.id, memberId: alice.id });
    // dave logs time on BOTH departments' tasks
    await a.post('/api/time-tracker', daveAuth, { category: 'WORK', durationMinutes: 30, taskId: sTask.id });
    t.clock.advanceMinutes(30);
    await a.post('/api/time-tracker', daveAuth, { category: 'WORK', durationMinutes: 20, taskId: fTask.id });
    const before = (await a.get('/api/time-tracker/today', daveAuth)).body.data;
    // alice asked Studio for something; dave asked nobody yet
    await a.post('/api/requests', aliceAuth, { toDepartmentId: studio.id, subject: 'Banner', message: 'Please' });

    // the warning tells the truth: carol + Studio's leader go; dave stays
    const impact = await a.get(`/api/departments/${studio.id}/impact`, superAuth);
    expect(impact.body.data.impact).toMatchObject({ members: 2, keptMembers: 1 });

    expect((await a.del(`/api/departments/${studio.id}`, superAuth)).status).toBe(204);

    const members = (await a.get('/api/members', superAuth)).body.data.members;
    const names = members.map((m: { fullName: string }) => m.fullName);
    expect(names).not.toContain('Carol C');
    expect(names).not.toContain('Studio Leader');
    expect(names).toEqual(expect.arrayContaining(['Alice A', 'Bob B', 'Dave D', 'Fintech Leader', 'Ops Leader']));
    // dave keeps his account and his OTHER membership; the deleted department is gone from it
    expect(members.find((m: { id: string }) => m.id === dave.id)).toMatchObject({ departmentIds: [fintech.id], shared: false });
    expect(await login(t, 'dave@example.com', 'dave-pass')).toContain('Bearer ');
    expect(await login(t, 'alice@example.com', 'alice-pass')).toContain('Bearer ');

    // tasks: Studio's are gone, Fintech's are untouched, dave still sees his Fintech task
    const titles = (await a.get('/api/admin/tasks', superAuth)).body.data.tasks.map((x: { title: string }) => x.title).sort();
    expect(titles).toEqual(["Alice's task", 'Fintech report']);
    expect((await a.get('/api/tasks', daveAuth)).body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['Fintech report']);

    // dave's TIME is kept in full (only the deleted task's link is dropped) — the ledger maths is untouched
    const after = (await a.get('/api/time-tracker/today', daveAuth)).body.data;
    expect(after.totals).toEqual(before.totals);
    expect(after.usedMinutes).toBe(before.usedMinutes);
    expect(after.entries.find((e: { taskTitle: string | null; durationMinutes: number }) => e.durationMinutes === 30)).toMatchObject({ taskId: null, taskTitle: null });
    expect(after.entries.find((e: { taskTitle: string | null; durationMinutes: number }) => e.durationMinutes === 20)).toMatchObject({ taskTitle: 'Fintech report' });

    // requests to the deleted department went with it; Fintech, Ops and their people are unaffected
    expect(t.repos.requests.rows).toHaveLength(0);
    expect((await a.get('/api/departments', superAuth)).body.data.departments.map((d: { name: string }) => d.name)).toEqual(['Fintech', 'Ops']);
    expect((await a.get('/api/members', fLead)).status).toBe(200);
    expect((await a.get('/api/members', sLead)).status).toBe(401); // Studio's leader is gone with it
  });

  it('a member who belongs ONLY to the deleted department is deleted with it, with all their data', async () => {
    const { t, a, superAuth, studio, carol } = await setupOrg();
    const carolAuth = await login(t, 'carol@example.com', 'carol-pass');
    await a.post('/api/time-tracker', carolAuth, { category: 'LEARNING', durationMinutes: 30 });
    const impact = await a.get(`/api/departments/${studio.id}/impact`, superAuth);
    expect(impact.body.data.impact).toMatchObject({ members: 2, keptMembers: 1, timeEntries: 1 });
    await a.del(`/api/departments/${studio.id}`, superAuth);
    expect(t.repos.timeTracker.trackers.some((x) => x.memberId === carol.id)).toBe(false);
    expect(t.repos.members.rows.some((m) => m.id === carol.id)).toBe(false);
  });
});
