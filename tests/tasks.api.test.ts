import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, TEST_ADMIN, type TestApp } from './helpers/test-app';

const LOCAL_MIDNIGHT_UTC = '2026-09-21T18:30:00.000Z'; // local midnight of 2026-09-22 IST
const UNKNOWN_ID = '0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11';

/** admin + two departments; alice & bob in Fintech, carol in Studio — all signed in. */
async function setupOrg(t: TestApp) {
  const adminAuth = await loginAdmin(t);
  const fintech = await createDepartment(t, adminAuth, 'Fintech');
  const studio = await createDepartment(t, adminAuth, 'Studio');
  const alice = await createMember(t, adminAuth, { username: 'alice@example.com', fullName: 'Alice A', password: 'alice-pass', departmentId: fintech.id });
  const bob = await createMember(t, adminAuth, { username: 'bob@example.com', fullName: 'Bob B', password: 'bob-pass', departmentId: fintech.id });
  const carol = await createMember(t, adminAuth, { username: 'carol@example.com', fullName: 'Carol C', password: 'carol-pass', departmentId: studio.id });
  return {
    adminAuth,
    fintech,
    studio,
    alice,
    bob,
    carol,
    aliceAuth: await login(t, 'alice@example.com', 'alice-pass'),
    bobAuth: await login(t, 'bob@example.com', 'bob-pass'),
    carolAuth: await login(t, 'carol@example.com', 'carol-pass'),
  };
}

const createTask = (t: TestApp, auth: string, body: object) => request(t.app).post('/api/admin/tasks').set('Authorization', auth).send(body);

describe('admin: creating and assigning tasks', () => {
  it('creates a task for a member of the chosen department; shows who/where/when', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice } = await setupOrg(t);
    const res = await createTask(t, adminAuth, { title: '  Fix login  ', description: ' Details ', departmentId: fintech.id, memberId: alice.id, dueDate: '2026-10-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({
      title: 'Fix login',
      description: 'Details',
      status: 'TODO',
      dueDate: '2026-10-01',
      departmentId: fintech.id,
      departmentName: 'Fintech',
      memberId: alice.id,
      memberName: 'Alice A',
      createdBy: TEST_ADMIN.username,
    });
    expect(res.body.data.task.createdAt).toBeTruthy();
  });

  it('refuses a member outside the department, a disabled member, an inactive/unknown department, an unknown member', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, studio, alice, carol } = await setupOrg(t);

    const wrongDept = await createTask(t, adminAuth, { title: 'X', departmentId: fintech.id, memberId: carol.id });
    expect(wrongDept.status).toBe(409);
    expect(wrongDept.body.code).toBe('MEMBER_NOT_IN_DEPARTMENT');

    await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: false });
    const disabled = await createTask(t, adminAuth, { title: 'X', departmentId: fintech.id, memberId: alice.id });
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe('MEMBER_INACTIVE');

    await request(t.app).patch(`/api/members/${carol.id}`).set('Authorization', adminAuth).send({ isActive: false });
    await request(t.app).patch(`/api/departments/${studio.id}`).set('Authorization', adminAuth).send({ isActive: false });
    const inactiveDept = await createTask(t, adminAuth, { title: 'X', departmentId: studio.id, memberId: carol.id });
    expect(inactiveDept.status).toBe(409);
    expect(inactiveDept.body.code).toBe('DEPARTMENT_INACTIVE');

    expect((await createTask(t, adminAuth, { title: 'X', departmentId: UNKNOWN_ID, memberId: carol.id })).status).toBe(404);
    expect((await createTask(t, adminAuth, { title: 'X', departmentId: fintech.id, memberId: UNKNOWN_ID })).status).toBe(404);
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['title over 200 chars', { title: 'x'.repeat(201) }],
    ['description over 1000 chars', { description: 'x'.repeat(1001) }],
    ['impossible due date', { dueDate: '2026-02-30' }],
    ['malformed due date', { dueDate: '01/10/2026' }],
    ['unknown status', { status: 'BLOCKED' }],
    ['non-uuid department', { departmentId: 'nope' }],
  ])('validates: %s', async (_label, patch) => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice } = await setupOrg(t);
    const res = await createTask(t, adminAuth, { title: 'T', departmentId: fintech.id, memberId: alice.id, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('member: "For You" — only my own tasks', () => {
  it("returns only the caller's tasks, open ones first (soonest due first), finished last", async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, studio, alice, bob, carol, aliceAuth } = await setupOrg(t);
    await createTask(t, adminAuth, { title: 'Alice later', departmentId: fintech.id, memberId: alice.id, dueDate: '2026-11-01' });
    await createTask(t, adminAuth, { title: 'Alice done', departmentId: fintech.id, memberId: alice.id, status: 'DONE', dueDate: '2026-09-01' });
    await createTask(t, adminAuth, { title: 'Alice sooner', departmentId: fintech.id, memberId: alice.id, dueDate: '2026-10-01' });
    await createTask(t, adminAuth, { title: 'Alice no date', departmentId: fintech.id, memberId: alice.id });
    await createTask(t, adminAuth, { title: "Bob's", departmentId: fintech.id, memberId: bob.id });
    await createTask(t, adminAuth, { title: "Carol's", departmentId: studio.id, memberId: carol.id });

    const res = await request(t.app).get('/api/tasks').set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.tasks.map((x: { title: string }) => x.title)).toEqual(['Alice sooner', 'Alice later', 'Alice no date', 'Alice done']);
    expect(res.body.data.tasks.every((x: { memberId: string }) => x.memberId === alice.id)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/Bob's|Carol's/);
  });

  it('a query-string memberId/departmentId can never widen what a member sees', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice, bob, aliceAuth } = await setupOrg(t);
    await createTask(t, adminAuth, { title: "Bob's secret", departmentId: fintech.id, memberId: bob.id });
    const res = await request(t.app).get(`/api/tasks?memberId=${bob.id}&departmentId=${fintech.id}`).set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toEqual([]);
    expect(alice.id).not.toBe(bob.id);
  });

  it('is member-only here, and admin-only on /api/admin/tasks', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice, aliceAuth } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'T', departmentId: fintech.id, memberId: alice.id })).body.data.task;

    expect((await request(t.app).get('/api/tasks').set('Authorization', adminAuth)).status).toBe(403);
    expect((await request(t.app).get('/api/tasks')).status).toBe(401);
    for (const call of [
      request(t.app).get('/api/admin/tasks'),
      request(t.app).post('/api/admin/tasks').send({ title: 'x', departmentId: fintech.id, memberId: alice.id }),
      request(t.app).patch(`/api/admin/tasks/${task.id}`).send({ status: 'DONE' }),
      request(t.app).delete(`/api/admin/tasks/${task.id}`),
    ]) {
      expect((await call.set('Authorization', aliceAuth)).status).toBe(403);
    }
    expect((await request(t.app).get('/api/admin/tasks')).status).toBe(401);
  });
});

describe('member: reporting progress on my own task', () => {
  const setStatus = (t: TestApp, auth: string, id: string, body: object) => request(t.app).patch(`/api/tasks/${id}/status`).set('Authorization', auth).send(body);

  it('lets a member start, finish and reopen their own task, and the admin sees the change', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice, aliceAuth } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'Ship it', departmentId: fintech.id, memberId: alice.id })).body.data.task;

    for (const status of ['IN_PROGRESS', 'DONE', 'TODO']) {
      const res = await setStatus(t, aliceAuth, task.id, { status });
      expect(res.status).toBe(200);
      expect(res.body.data.task.status).toBe(status);
      const seen = await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth);
      expect(seen.body.data.tasks[0].status).toBe(status);
    }
  });

  it("cannot touch another member's task — reported as not found, and nothing changes", async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice, bobAuth } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: "Alice's", departmentId: fintech.id, memberId: alice.id })).body.data.task;

    const res = await setStatus(t, bobAuth, task.id, { status: 'DONE' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
    expect((await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks[0].status).toBe('TODO');
    expect((await setStatus(t, bobAuth, UNKNOWN_ID, { status: 'DONE' })).status).toBe(404);
  });

  it('changes nothing but the status, rejects a bad status, and is member-only', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, studio, alice, aliceAuth } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'Keep me', departmentId: fintech.id, memberId: alice.id })).body.data.task;

    expect((await setStatus(t, aliceAuth, task.id, { status: 'DONE', title: 'Renamed' })).status).toBe(400);
    expect((await setStatus(t, aliceAuth, task.id, { status: 'DONE', memberId: alice.id, departmentId: studio.id })).status).toBe(400);
    expect((await setStatus(t, aliceAuth, task.id, { status: 'FINISHED' })).status).toBe(400);
    expect((await setStatus(t, aliceAuth, task.id, {})).status).toBe(400);
    expect((await setStatus(t, adminAuth, task.id, { status: 'DONE' })).status).toBe(403);
    expect((await request(t.app).patch(`/api/tasks/${task.id}/status`).send({ status: 'DONE' })).status).toBe(401);
    const after = (await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks[0];
    expect(after).toMatchObject({ title: 'Keep me', status: 'TODO' });
  });
});

describe('member: stopwatch on my own task', () => {
  const start = (t: TestApp, auth: string, id: string) => request(t.app).post(`/api/tasks/${id}/timer`).set('Authorization', auth);
  const discard = (t: TestApp, auth: string, id: string) => request(t.app).delete(`/api/tasks/${id}/timer`).set('Authorization', auth);
  const mine = async (t: TestApp, auth: string) => (await request(t.app).get('/api/tasks').set('Authorization', auth)).body.data.tasks as Array<{ id: string; status: string; timerStartedAt: string | null }>;

  async function twoTasks() {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const org = await setupOrg(t);
    const mk = async (title: string, memberId: string) => (await createTask(t, org.adminAuth, { title, departmentId: org.fintech.id, memberId })).body.data.task;
    return { t, ...org, one: await mk('One', org.alice.id), two: await mk('Two', org.alice.id), bobs: await mk("Bob's", org.bob.id) };
  }

  it('start records the instant, marks a To-do task In progress, and is visible to the admin', async () => {
    const { t, adminAuth, aliceAuth, one } = await twoTasks();
    const res = await start(t, aliceAuth, one.id);
    expect(res.status).toBe(200);
    expect(res.body.data.task).toMatchObject({ status: 'IN_PROGRESS', timerStartedAt: t.clock.now().toISOString() });
    const seen = (await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks;
    expect(seen.find((x: { id: string }) => x.id === one.id).timerStartedAt).toBe(t.clock.now().toISOString());
  });

  it('starting it again is a no-op that keeps the original start time', async () => {
    const { t, aliceAuth, one } = await twoTasks();
    const first = (await start(t, aliceAuth, one.id)).body.data.task.timerStartedAt;
    t.clock.advanceMinutes(15);
    expect((await start(t, aliceAuth, one.id)).body.data.task.timerStartedAt).toBe(first);
  });

  it('only ONE stopwatch per member; another member can run theirs at the same time', async () => {
    const { t, aliceAuth, bobAuth, one, two, bobs } = await twoTasks();
    await start(t, aliceAuth, one.id);
    const second = await start(t, aliceAuth, two.id);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TIMER_ALREADY_RUNNING');
    expect(second.body.message).toContain('One');
    expect((await start(t, bobAuth, bobs.id)).status).toBe(200);
    expect((await mine(t, aliceAuth)).find((x) => x.id === two.id)?.timerStartedAt).toBeNull();
  });

  it("can't touch someone else's task, an unknown one, or a finished one — and is member-only", async () => {
    const { t, adminAuth, aliceAuth, one, bobs } = await twoTasks();
    expect((await start(t, aliceAuth, bobs.id)).status).toBe(404);
    expect((await discard(t, aliceAuth, bobs.id)).status).toBe(404);
    expect((await start(t, aliceAuth, UNKNOWN_ID)).status).toBe(404);
    expect((await start(t, adminAuth, one.id)).status).toBe(403);
    expect((await request(t.app).post(`/api/tasks/${one.id}/timer`)).status).toBe(401);
    await request(t.app).patch(`/api/tasks/${one.id}/status`).set('Authorization', aliceAuth).send({ status: 'DONE' });
    const done = await start(t, aliceAuth, one.id);
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('TASK_CLOSED');
  });

  it('discard clears it without logging anything', async () => {
    const { t, aliceAuth, one, two } = await twoTasks();
    await start(t, aliceAuth, one.id);
    const res = await discard(t, aliceAuth, one.id);
    expect(res.body.data.task.timerStartedAt).toBeNull();
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth)).body.data.entries).toEqual([]);
    expect((await start(t, aliceAuth, two.id)).status).toBe(200); // free to start another now
  });

  it('saving time against the task ends the stopwatch — and the ledger maths is exactly what it was without one', async () => {
    const { t, aliceAuth, one } = await twoTasks();
    await start(t, aliceAuth, one.id);
    t.clock.advanceMinutes(30);
    const saved = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30, taskId: one.id });
    expect(saved.status).toBe(201);
    // 90-minute window (60 before the timer + 30 after): 30 tracked + 60 gap — the stopwatch changed nothing.
    expect(saved.body.data).toMatchObject({ totals: { WORK: 30, BASE: 60 }, usedMinutes: 90 });
    expect((await mine(t, aliceAuth)).find((x) => x.id === one.id)).toMatchObject({ timerStartedAt: null, status: 'IN_PROGRESS' });
  });

  it('a refused entry leaves the stopwatch running; an entry for a different task leaves it alone', async () => {
    const { t, aliceAuth, one, two } = await twoTasks();
    await start(t, aliceAuth, one.id);
    expect((await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 999, taskId: one.id })).status).toBe(409);
    expect((await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 10, taskId: two.id })).status).toBe(201);
    expect((await mine(t, aliceAuth)).find((x) => x.id === one.id)?.timerStartedAt).not.toBeNull();
  });

  it('finishing the task, or reassigning it, clears the stopwatch', async () => {
    const { t, adminAuth, aliceAuth, one, two, bob } = await twoTasks();
    await start(t, aliceAuth, one.id);
    await request(t.app).patch(`/api/tasks/${one.id}/status`).set('Authorization', aliceAuth).send({ status: 'DONE' });
    expect((await mine(t, aliceAuth)).find((x) => x.id === one.id)?.timerStartedAt).toBeNull();

    await start(t, aliceAuth, two.id);
    await request(t.app).patch(`/api/admin/tasks/${two.id}`).set('Authorization', adminAuth).send({ memberId: bob.id });
    const all = (await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks;
    expect(all.find((x: { id: string }) => x.id === two.id)).toMatchObject({ memberId: bob.id, timerStartedAt: null });
  });
});

describe('task completion time', () => {
  it('is stamped when a task is marked Done, kept if Done again, and cleared on reopen — whoever changes it', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice, aliceAuth } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'T', departmentId: fintech.id, memberId: alice.id })).body.data.task;
    expect(task.completedAt).toBeNull();

    const done = await request(t.app).patch(`/api/tasks/${task.id}/status`).set('Authorization', aliceAuth).send({ status: 'DONE' });
    const stamp = done.body.data.task.completedAt as string;
    expect(new Date(stamp).toString()).not.toBe('Invalid Date');

    t.clock.advanceMinutes(10);
    const again = await request(t.app).patch(`/api/admin/tasks/${task.id}`).set('Authorization', adminAuth).send({ status: 'DONE' });
    expect(again.body.data.task.completedAt).toBe(stamp);

    const reopened = await request(t.app).patch(`/api/tasks/${task.id}/status`).set('Authorization', aliceAuth).send({ status: 'IN_PROGRESS' });
    expect(reopened.body.data.task.completedAt).toBeNull();

    const bornDone = await createTask(t, adminAuth, { title: 'Already done', departmentId: fintech.id, memberId: alice.id, status: 'DONE' });
    expect(bornDone.body.data.task.completedAt).not.toBeNull();
  });
});

describe('admin: seeing and managing all tasks', () => {
  it('lists every task and filters by department, member and status (combined)', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, studio, alice, bob, carol } = await setupOrg(t);
    await createTask(t, adminAuth, { title: 'A1', departmentId: fintech.id, memberId: alice.id });
    await createTask(t, adminAuth, { title: 'A2', departmentId: fintech.id, memberId: alice.id, status: 'DONE' });
    await createTask(t, adminAuth, { title: 'B1', departmentId: fintech.id, memberId: bob.id });
    await createTask(t, adminAuth, { title: 'C1', departmentId: studio.id, memberId: carol.id });
    const titles = async (qs: string) =>
      ((await request(t.app).get(`/api/admin/tasks${qs}`).set('Authorization', adminAuth)).body.data.tasks as { title: string }[]).map((x) => x.title).sort();

    expect(await titles('')).toEqual(['A1', 'A2', 'B1', 'C1']);
    expect(await titles(`?departmentId=${fintech.id}`)).toEqual(['A1', 'A2', 'B1']);
    expect(await titles(`?memberId=${alice.id}`)).toEqual(['A1', 'A2']);
    expect(await titles('?status=DONE')).toEqual(['A2']);
    expect(await titles(`?departmentId=${fintech.id}&memberId=${alice.id}&status=TODO`)).toEqual(['A1']);
    expect(await titles(`?departmentId=${studio.id}&memberId=${alice.id}`)).toEqual([]);
    expect((await request(t.app).get('/api/admin/tasks?status=NOPE').set('Authorization', adminAuth)).status).toBe(400);
  });

  it('edits title/description/status/due date, clears optional fields, and validates a reassignment', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, studio, alice, bob, carol } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'Old', description: 'D', departmentId: fintech.id, memberId: alice.id, dueDate: '2026-10-01' })).body.data.task;
    const patch = (body: object) => request(t.app).patch(`/api/admin/tasks/${task.id}`).set('Authorization', adminAuth).send(body);

    const edited = await patch({ title: 'New', status: 'IN_PROGRESS', description: '', dueDate: null });
    expect(edited.body.data.task).toMatchObject({ title: 'New', status: 'IN_PROGRESS', description: null, dueDate: null });

    expect((await patch({ memberId: bob.id })).body.data.task.memberName).toBe('Bob B'); // same department
    const cross = await patch({ memberId: carol.id }); // other department, department unchanged
    expect(cross.status).toBe(409);
    expect(cross.body.code).toBe('MEMBER_NOT_IN_DEPARTMENT');
    const moved = await patch({ departmentId: studio.id, memberId: carol.id }); // both change together
    expect(moved.body.data.task).toMatchObject({ departmentName: 'Studio', memberName: 'Carol C' });

    expect((await patch({})).status).toBe(400);
    expect((await request(t.app).patch(`/api/admin/tasks/${UNKNOWN_ID}`).set('Authorization', adminAuth).send({ title: 'X' })).status).toBe(404);
  });

  it('still lets an admin change a task\'s status after its member was disabled (assignment unchanged)', async () => {
    const t = buildTestApp();
    const { adminAuth, fintech, alice } = await setupOrg(t);
    const task = (await createTask(t, adminAuth, { title: 'T', departmentId: fintech.id, memberId: alice.id })).body.data.task;
    await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: false });
    const done = await request(t.app).patch(`/api/admin/tasks/${task.id}`).set('Authorization', adminAuth).send({ status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.data.task.status).toBe('DONE');
  });

  it('deletes any task; time already logged against it is kept, just unlinked', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, fintech, alice, aliceAuth } = await setupOrg(t);
    const a = (await createTask(t, adminAuth, { title: 'Free', departmentId: fintech.id, memberId: alice.id })).body.data.task;
    const b = (await createTask(t, adminAuth, { title: 'Used', departmentId: fintech.id, memberId: alice.id })).body.data.task;
    const logged = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40, taskId: b.id });
    expect(logged.body.data.entries[0].taskTitle).toBe('Used');

    expect((await request(t.app).delete(`/api/admin/tasks/${a.id}`).set('Authorization', adminAuth)).status).toBe(204);
    expect((await request(t.app).delete(`/api/admin/tasks/${b.id}`).set('Authorization', adminAuth)).status).toBe(204);
    expect((await request(t.app).get('/api/admin/tasks').set('Authorization', adminAuth)).body.data.tasks).toEqual([]);
    expect((await request(t.app).delete(`/api/admin/tasks/${UNKNOWN_ID}`).set('Authorization', adminAuth)).status).toBe(404);

    // The member's time is exactly as it was (40 tracked + 20 gap); only the task label is gone.
    const today = (await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth)).body.data;
    expect(today).toMatchObject({ totals: { WORK: 40, BASE: 20 }, usedMinutes: 60, remainingMinutes: 1380 });
    expect(today.entries[0]).toMatchObject({ entryType: 'TRACKER', durationMinutes: 40, taskId: null, taskTitle: null });
  });
});

describe('tasks + the Time Tracker', () => {
  async function loggedOnTask() {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const org = await setupOrg(t);
    const task = (await createTask(t, org.adminAuth, { title: 'Payment module', departmentId: org.fintech.id, memberId: org.alice.id })).body.data.task;
    return { t, ...org, task };
  }
  const log = (t: TestApp, auth: string, body: object) => request(t.app).post('/api/time-tracker').set('Authorization', auth).send(body);

  it('a member logs time against their own task; the entry shows it, the gap row does not, and the maths is unchanged', async () => {
    const { t, aliceAuth, task } = await loggedOnTask();
    const res = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 40, taskId: task.id });
    expect(res.status).toBe(201);
    expect(res.body.data.entries).toMatchObject([
      { entryType: 'TRACKER', taskId: task.id, taskTitle: 'Payment module' },
      { entryType: 'GAP', taskId: null, taskTitle: null },
    ]);
    // Identical to a tracker with no task: 60-minute window = 40 tracked + 20 gap.
    expect(res.body.data).toMatchObject({ totals: { WORK: 40, BASE: 20 }, usedMinutes: 60, remainingMinutes: 1380 });
  });

  it('the first time logged against a To-do task moves it to In progress; nothing else changes its status', async () => {
    const { t, aliceAuth, adminAuth, task } = await loggedOnTask();
    const status = async () => (await request(t.app).get('/api/tasks').set('Authorization', aliceAuth)).body.data.tasks[0].status;
    expect(await status()).toBe('TODO');
    // a refused log (too long for the window) must not start the task
    expect((await log(t, aliceAuth, { category: 'WORK', durationMinutes: 999, taskId: task.id })).status).toBe(409);
    expect(await status()).toBe('TODO');

    const created = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 30, taskId: task.id });
    expect(await status()).toBe('IN_PROGRESS');

    // reopening it on purpose sticks: editing an entry that keeps the same task doesn't flip it back
    await request(t.app).patch(`/api/tasks/${task.id}/status`).set('Authorization', aliceAuth).send({ status: 'TODO' });
    const trackerId = created.body.data.entries[0].trackerId as string;
    await request(t.app).patch(`/api/time-tracker/${trackerId}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30, taskId: task.id });
    expect(await status()).toBe('TODO');
    expect(adminAuth).toBeTruthy();
  });

  it('reports minutes logged per task (tracked time only, not the gap) to member and admin, and follows edits and deletes', async () => {
    const { t, aliceAuth, adminAuth, task } = await loggedOnTask();
    const minutes = async (auth: string, path: string) => (await request(t.app).get(path).set('Authorization', auth)).body.data.tasks[0].loggedMinutes;
    expect(await minutes(aliceAuth, '/api/tasks')).toBe(0);

    const first = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 40, taskId: task.id }); // 60 window → 20 gap
    expect(await minutes(aliceAuth, '/api/tasks')).toBe(40);
    t.clock.advanceMinutes(30);
    await log(t, aliceAuth, { category: 'WORK', durationMinutes: 10, taskId: task.id });
    expect(await minutes(adminAuth, '/api/admin/tasks')).toBe(50);

    const trackerId = first.body.data.entries[0].trackerId as string;
    await request(t.app).patch(`/api/time-tracker/${trackerId}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 45 });
    expect(await minutes(aliceAuth, '/api/tasks')).toBe(55);
    await request(t.app).delete(`/api/time-tracker/${trackerId}`).set('Authorization', aliceAuth);
    expect(await minutes(aliceAuth, '/api/tasks')).toBe(10);
  });

  it('an entry without a task behaves exactly as before', async () => {
    const { t, aliceAuth } = await loggedOnTask();
    const res = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 40 });
    expect(res.body.data.entries[0]).toMatchObject({ entryType: 'TRACKER', taskId: null, taskTitle: null });
    expect(res.body.data.usedMinutes).toBe(60);
  });

  it("a member can't log against someone else's task, an unknown task, or a finished one", async () => {
    const { t, adminAuth, fintech, bob, aliceAuth, bobAuth, alice, task } = await loggedOnTask();
    const bobsTask = (await createTask(t, adminAuth, { title: "Bob's", departmentId: fintech.id, memberId: bob.id })).body.data.task;
    const other = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 10, taskId: bobsTask.id });
    expect(other.status).toBe(404); // reported as not-found, never as "not yours"
    expect(other.body.code).toBe('TASK_NOT_FOUND');
    expect((await log(t, aliceAuth, { category: 'WORK', durationMinutes: 10, taskId: UNKNOWN_ID })).status).toBe(404);
    expect((await log(t, aliceAuth, { category: 'WORK', durationMinutes: 10, taskId: 'not-a-uuid' })).status).toBe(400);

    await request(t.app).patch(`/api/admin/tasks/${task.id}`).set('Authorization', adminAuth).send({ status: 'DONE' });
    const done = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 10, taskId: task.id });
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('TASK_CLOSED');

    // Nothing was written by any refused attempt.
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth)).body.data.entries).toEqual([]);
    expect(bobAuth && alice).toBeTruthy();
  });

  it('editing: omitted taskId keeps the link, null unlinks, a new task must be the owner\'s own — admin edits keep the link', async () => {
    const { t, adminAuth, fintech, bob, aliceAuth, task } = await loggedOnTask();
    const created = await log(t, aliceAuth, { category: 'WORK', durationMinutes: 40, taskId: task.id });
    const trackerId = created.body.data.entries[0].trackerId as string;
    const edit = (auth: string, base: string, body: object) => request(t.app).patch(`${base}/${trackerId}`).set('Authorization', auth).send(body);

    expect((await request(t.app).get(`/api/time-tracker/${trackerId}`).set('Authorization', aliceAuth)).body.data.taskId).toBe(task.id);

    // member edit without taskId (e.g. only the comment changed) keeps it
    const kept = await edit(aliceAuth, '/api/time-tracker', { category: 'WORK', durationMinutes: 40, comment: 'note' });
    expect(kept.body.data.entries[0].taskId).toBe(task.id);
    // admin edit (the admin modal never sends taskId) keeps it too
    const adminEdit = await edit(adminAuth, '/api/admin/time-tracker', { category: 'WORK', durationMinutes: 30 });
    expect(adminEdit.body.data.entries[0].taskId).toBe(task.id);

    // linking to another member's task is refused
    const bobsTask = (await createTask(t, adminAuth, { title: "Bob's", departmentId: fintech.id, memberId: bob.id })).body.data.task;
    expect((await edit(aliceAuth, '/api/time-tracker', { category: 'WORK', durationMinutes: 40, taskId: bobsTask.id })).status).toBe(404);

    // finishing the task doesn't block editing an entry that already has it
    await request(t.app).patch(`/api/admin/tasks/${task.id}`).set('Authorization', adminAuth).send({ status: 'DONE' });
    expect((await edit(aliceAuth, '/api/time-tracker', { category: 'WORK', durationMinutes: 40, taskId: task.id })).status).toBe(200);

    // explicit null unlinks
    const unlinked = await edit(aliceAuth, '/api/time-tracker', { category: 'WORK', durationMinutes: 40, taskId: null });
    expect(unlinked.body.data.entries[0]).toMatchObject({ taskId: null, taskTitle: null });
  });

  it('activity history shows each entry\'s task and can be narrowed by department', async () => {
    const { t, adminAuth, fintech, studio, carol, aliceAuth, carolAuth, task } = await loggedOnTask();
    await log(t, aliceAuth, { category: 'WORK', durationMinutes: 30, taskId: task.id });
    await log(t, carolAuth, { category: 'LEARNING', durationMinutes: 20 });
    const history = (qs: string) => request(t.app).get(`/api/admin/time-tracker/history?date=2026-09-22${qs}`).set('Authorization', adminAuth);

    const all = await history('');
    // each entry says which tracker it came from, so a client can show a tracker and its own gap as one
    const rows = all.body.data.entries as Array<{ entryType: string; trackerId: string | null; memberId: string }>;
    const aliceTracker = rows.find((e) => e.entryType === 'TRACKER' && e.memberId === all.body.data.entries.find((x: { taskTitle: string | null }) => x.taskTitle)?.memberId);
    expect(aliceTracker?.trackerId).toEqual(expect.any(String));
    expect(rows.filter((e) => e.entryType === 'GAP' && e.trackerId).every((g) => rows.some((r) => r.entryType === 'TRACKER' && r.trackerId === g.trackerId))).toBe(true);
    const aliceRow = all.body.data.entries.find((e: { entryType: string; memberName: string }) => e.entryType === 'TRACKER' && e.memberName === 'Alice A');
    expect(aliceRow.taskTitle).toBe('Payment module');
    expect(all.body.data.summary.memberCount).toBe(2);

    const onlyFintech = await history(`&departmentId=${fintech.id}`);
    expect(new Set(onlyFintech.body.data.entries.map((e: { memberName: string }) => e.memberName))).toEqual(new Set(['Alice A']));
    const onlyStudio = await history(`&departmentId=${studio.id}`);
    expect(new Set(onlyStudio.body.data.entries.map((e: { memberName: string }) => e.memberName))).toEqual(new Set(['Carol C']));

    // department + a member outside it → nothing (and no per-member summary leak)
    const mismatch = await history(`&departmentId=${fintech.id}&memberId=${carol.id}`);
    expect(mismatch.body.data.entries).toEqual([]);
    expect(mismatch.body.data.memberSummary).toBeNull();
    // an empty department → nothing
    const empty = (await createDepartment(t, adminAuth, 'Nobody')).id;
    expect((await history(`&departmentId=${empty}`)).body.data.entries).toEqual([]);
  });

  it("a member's own history ignores a departmentId in the query and still shows only their entries", async () => {
    const { t, studio, aliceAuth, carolAuth } = await loggedOnTask();
    await log(t, aliceAuth, { category: 'WORK', durationMinutes: 30 });
    await log(t, carolAuth, { category: 'LEARNING', durationMinutes: 20 });
    const res = await request(t.app).get(`/api/time-tracker/history?date=2026-09-22&departmentId=${studio.id}`).set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(new Set(res.body.data.entries.map((e: { memberName: string }) => e.memberName))).toEqual(new Set(['Alice A']));
  });

  it('the admin overview carries each member\'s department for grouping', async () => {
    const { t, adminAuth, fintech, alice } = await loggedOnTask();
    const res = await request(t.app).get('/api/admin/time-tracker').set('Authorization', adminAuth);
    const row = res.body.data.members.find((m: { memberId: string }) => m.memberId === alice.id);
    expect(row.departmentIds).toEqual([fintech.id]);
  });
});
