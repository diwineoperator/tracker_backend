import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, loginLeader, type TestApp } from './helpers/test-app';

const api = (t: TestApp) => ({
  get: (path: string, auth?: string) => (auth ? request(t.app).get(path).set('Authorization', auth) : request(t.app).get(path)),
  post: (path: string, auth: string, body: object = {}) => request(t.app).post(path).set('Authorization', auth).send(body),
  patch: (path: string, auth: string, body: object) => request(t.app).patch(path).set('Authorization', auth).send(body),
});

/** Fintech (leader, alice, bob) and Studio (leader, carol), everyone signed in. */
async function setup() {
  const t = buildTestApp();
  const superAuth = await loginAdmin(t);
  const fintech = await createDepartment(t, superAuth, 'Fintech');
  const studio = await createDepartment(t, superAuth, 'Studio');
  const mk = (n: string, departmentId: string) => createMember(t, superAuth, { username: `${n}@example.com`, fullName: n, password: `${n}-pass`, departmentId });
  const alice = await mk('alice', fintech.id);
  const bob = await mk('bob', fintech.id);
  const carol = await mk('carol', studio.id);
  return {
    t,
    a: api(t),
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

describe('member badges: For You', () => {
  it("counts only MY tasks that are not Done, and follows their status", async () => {
    const { a, fLead, fintech, alice, bob, aliceAuth, bobAuth } = await setup();
    const mk = (title: string, memberId: string) => a.post('/api/admin/tasks', fLead, { title, departmentId: fintech.id, memberId });
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(0);

    const t1 = (await mk('One', alice.id)).body.data.task;
    await mk('Two', alice.id);
    await mk("Bob's", bob.id);
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(2); // not bob's
    expect((await a.get('/api/badges', bobAuth)).body.data.forYou).toBe(1);

    await a.patch(`/api/tasks/${t1.id}/status`, aliceAuth, { status: 'IN_PROGRESS' });
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(2); // in progress is still pending
    await a.patch(`/api/tasks/${t1.id}/status`, aliceAuth, { status: 'DONE' });
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(1);
    await a.patch(`/api/tasks/${t1.id}/status`, aliceAuth, { status: 'TODO' }); // reopened
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(2);
  });
});

describe('member badges: For You = tasks handed to me since I last looked', () => {
  it('a new assignment (by a leader or the super admin) shows up; once seen it clears; a later one shows again', async () => {
    const { a, fLead, superAuth, fintech, alice, aliceAuth } = await setup();
    const mk = (auth: string, title: string) => a.post('/api/admin/tasks', auth, { title, departmentId: fintech.id, memberId: alice.id });
    await mk(fLead, 'From leader');
    await mk(superAuth, 'From super admin');
    expect((await a.get('/api/badges', aliceAuth)).body.data.forYou).toBe(2);

    const seen = new Date(Date.now() + 1000).toISOString(); // "I opened For You just now"
    expect((await a.get(`/api/badges?tasksSince=${encodeURIComponent(seen)}`, aliceAuth)).body.data.forYou).toBe(0);
    expect((await a.get('/api/badges?tasksSince=2000-01-01T00:00:00Z', aliceAuth)).body.data.forYou).toBe(2);
    expect((await a.get('/api/badges?tasksSince=not-a-date', aliceAuth)).status).toBe(400);
  });

  it('progress on a task is not a new assignment, but reassigning it to someone else is', async () => {
    const { t, a, fLead, fintech, alice, bob, aliceAuth, bobAuth } = await setup();
    const task = (await a.post('/api/admin/tasks', fLead, { title: 'One', departmentId: fintech.id, memberId: alice.id })).body.data.task;
    const seen = new Date(Date.now() + 1000).toISOString();
    const since = `?tasksSince=${encodeURIComponent(seen)}`;
    await a.patch(`/api/tasks/${task.id}/status`, aliceAuth, { status: 'IN_PROGRESS' });
    expect((await a.get(`/api/badges${since}`, aliceAuth)).body.data.forYou).toBe(0);

    t.clock.advanceMinutes(60 * 24 * 365 * 50); // well past the real "now" used for `seen`
    await a.patch(`/api/admin/tasks/${task.id}`, fLead, { memberId: bob.id });
    expect((await a.get(`/api/badges${since}`, bobAuth)).body.data.forYou).toBe(1);
    expect((await a.get(`/api/badges${since}`, aliceAuth)).body.data.forYou).toBe(0);
  });
});

describe('member badges: Requests = replies I have not looked at', () => {
  it('counts my requests a leader has answered or moved on; a plain unanswered one is not "unread"', async () => {
    const { t, a, studio, aliceAuth, bobAuth, sLead } = await setup();
    const send = (auth: string, subject: string) => a.post('/api/requests', auth, { toDepartmentId: studio.id, subject, message: 'm' });
    const r1 = (await send(aliceAuth, 'One')).body.data.request;
    const r2 = (await send(aliceAuth, 'Two')).body.data.request;
    await send(bobAuth, "Bob's");
    expect((await a.get('/api/badges', aliceAuth)).body.data.requests).toBe(0); // nothing answered yet

    t.clock.advanceMinutes(5);
    await a.patch(`/api/admin/requests/${r1.id}`, sLead, { status: 'IN_PROGRESS' });
    await a.patch(`/api/admin/requests/${r2.id}`, sLead, { response: 'On it.' });
    expect((await a.get('/api/badges', aliceAuth)).body.data.requests).toBe(2);
    expect((await a.get('/api/badges', bobAuth)).body.data.requests).toBe(0); // bob's is still unanswered — and alice's aren't his
  });

  it('only counts what changed after the moment I last looked (requestsSince), and validates it', async () => {
    const { a, studio, aliceAuth, sLead } = await setup();
    const r = (await a.post('/api/requests', aliceAuth, { toDepartmentId: studio.id, subject: 'One', message: 'm' })).body.data.request;
    await a.patch(`/api/admin/requests/${r.id}`, sLead, { response: 'Done.', status: 'DONE' });

    expect((await a.get('/api/badges?requestsSince=2000-01-01T00:00:00Z', aliceAuth)).body.data.requests).toBe(1);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await a.get(`/api/badges?requestsSince=${encodeURIComponent(future)}`, aliceAuth)).body.data.requests).toBe(0); // already seen
    expect((await a.get('/api/badges?requestsSince=not-a-date', aliceAuth)).status).toBe(400);
  });
});

describe('staff badges: Requests waiting for a response', () => {
  it("a leader counts only OPEN requests addressed to THEIR department; the super admin counts all", async () => {
    const { a, fintech, studio, alice, aliceAuth, carolAuth, fLead, sLead, superAuth } = await setup();
    expect((await a.get('/api/admin/badges', sLead)).body.data.requests).toBe(0);

    const toStudio = (await a.post('/api/requests', aliceAuth, { toDepartmentId: studio.id, subject: 'A→S 1', message: 'm' })).body.data.request;
    await a.post('/api/requests', aliceAuth, { toDepartmentId: studio.id, subject: 'A→S 2', message: 'm' });
    await a.post('/api/requests', carolAuth, { toDepartmentId: fintech.id, subject: 'C→F', message: 'm' });
    expect((await a.get('/api/admin/badges', sLead)).body.data.requests).toBe(2);
    expect((await a.get('/api/admin/badges', fLead)).body.data.requests).toBe(1); // never the other department's
    expect((await a.get('/api/admin/badges', superAuth)).body.data.requests).toBe(3);

    await a.patch(`/api/admin/requests/${toStudio.id}`, sLead, { status: 'IN_PROGRESS' }); // handled → no longer waiting
    expect((await a.get('/api/admin/badges', sLead)).body.data.requests).toBe(1);
    expect(alice.id).toBeTruthy();
  });

  it("a leader also gets their own For You badge — work assigned directly to them; the super admin never gets one (nothing is ever assigned to them)", async () => {
    const { a, fintech, fLead, sLead, superAuth } = await setup();
    expect((await a.get('/api/admin/badges', fLead)).body.data.forYou).toBe(0);
    expect((await a.get('/api/admin/badges', superAuth)).body.data.forYou).toBeUndefined();

    const studioLeaderId = (await a.get('/api/departments', superAuth)).body.data.departments.find((d: { name: string }) => d.name === 'Studio').leaderId;
    await a.post('/api/admin/tasks', fLead, { title: 'For Studio Lead', memberId: studioLeaderId });
    expect((await a.get('/api/admin/badges', sLead)).body.data.forYou).toBe(1);
    expect((await a.get('/api/admin/badges', fLead)).body.data.forYou).toBe(0); // never counts someone else's

    const seen = new Date(Date.now() + 1000).toISOString();
    expect((await a.get(`/api/admin/badges?tasksSince=${encodeURIComponent(seen)}`, sLead)).body.data.forYou).toBe(0);
    expect((await a.get('/api/admin/badges?tasksSince=2000-01-01T00:00:00Z', sLead)).body.data.forYou).toBe(1);
    expect((await a.get('/api/admin/badges?tasksSince=not-a-date', sLead)).status).toBe(400);
    expect(fintech.id).toBeTruthy();
  });
});

describe('badges: who may ask', () => {
  it('members use /api/badges, staff use /api/admin/badges — never the other way round — and nobody without a session', async () => {
    const { a, aliceAuth, fLead, superAuth } = await setup();
    expect((await a.get('/api/admin/badges', aliceAuth)).status).toBe(403);
    expect((await a.get('/api/badges', fLead)).status).toBe(403);
    expect((await a.get('/api/badges', superAuth)).status).toBe(403);
    expect((await a.get('/api/badges')).status).toBe(401);
    expect((await a.get('/api/admin/badges')).status).toBe(401);
    expect((await a.get('/api/admin/badges', superAuth)).status).toBe(200);
  });
});
