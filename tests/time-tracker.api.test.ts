import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createMember, login, loginAdmin, setupAlice } from './helpers/test-app';

// TIMEZONE is Asia/Kolkata (UTC+5:30) in every test app. Local midnight for
// 2026-09-22 IST is 2026-09-21T18:30:00.000Z — every start time below is chosen
// relative to that so the DLD's own worked example (§16) can be reproduced exactly.
const LOCAL_MIDNIGHT_UTC = '2026-09-21T18:30:00.000Z';
const NINE_AM_IST_UTC = '2026-09-22T03:30:00.000Z'; // 9 hours after local midnight

describe('member: time tracker', () => {
  it("first tracker of the day: window is since local midnight, and the leftover becomes BASE", async () => {
    const t = buildTestApp(NINE_AM_IST_UTC);
    const { aliceAuth } = await setupAlice(t);

    const res = await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'SLEEP', durationMinutes: 480 }); // 8 hours; 9 available since midnight
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      totals: { SLEEP: 480, BASE: 60 },
      usedMinutes: 540,
      remainingMinutes: 900,
      status: 'OPEN',
    });
    expect(res.body.data.entries).toMatchObject([
      { category: 'SLEEP', durationMinutes: 480, entryType: 'TRACKER' },
      { category: 'BASE', durationMinutes: 60, entryType: 'GAP' },
    ]);
  });

  it('reproduces the DLD\'s own worked example (§16) across three trackers in one day', async () => {
    const t = buildTestApp(NINE_AM_IST_UTC);
    const { aliceAuth } = await setupAlice(t);
    const post = (body: object) => request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send(body);

    await post({ category: 'SLEEP', durationMinutes: 480 }); // 09:00, Sleep 8h -> Base 1h
    t.clock.set('2026-09-22T06:30:00.000Z'); // 12:00 PM IST (3h later)
    await post({ category: 'WORK', subcategory: 'Development', durationMinutes: 120 }); // Work 2h -> Base 1h
    t.clock.set('2026-09-22T11:30:00.000Z'); // 5:00 PM IST (5h later)
    const third = await post({ category: 'WORK', durationMinutes: 240 }); // Work 4h -> Base 1h

    expect(third.body.data).toMatchObject({
      totals: { SLEEP: 480, WORK: 360, BASE: 180 },
      usedMinutes: 1020, // 17h
      remainingMinutes: 420, // 7h
    });
  });

  it('gapCategory books the leftover as that category instead of BASE', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60); // 1 hour available, first tracker of the day
    const { aliceAuth } = await setupAlice(t);
    const res = await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'WORK', durationMinutes: 30, gapCategory: 'HEALTH' });
    expect(res.body.data.totals).toMatchObject({ WORK: 30, HEALTH: 30, BASE: 0 });
    expect(res.body.data.entries).toMatchObject([
      { category: 'WORK', entryType: 'TRACKER' },
      { category: 'HEALTH', entryType: 'GAP' },
    ]);
  });

  it('an exact-window duration books no GAP row at all', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(30);
    const { aliceAuth } = await setupAlice(t);
    const res = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30 });
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0]).toMatchObject({ category: 'WORK', entryType: 'TRACKER' });
    expect(res.body.data.totals.BASE).toBe(0);
  });

  it('rejects a duration greater than the available window', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60); // 1 hour available
    const { aliceAuth } = await setupAlice(t);
    const res = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 90 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DURATION_EXCEEDS_AVAILABLE');
    expect(res.body.details).toMatchObject({ availableMinutes: 60 });
  });

  it('rounds the elapsed window to the NEAREST whole minute, not truncation (0-29s down, 30-59s up)', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    const { aliceAuth } = await setupAlice(t);
    const midnight = new Date(LOCAL_MIDNIGHT_UTC).getTime();

    // No tracker is ever actually created in this test (every request is rejected
    // as exceeding the window), so `previousTrackerTime` never advances past local
    // midnight — each case below is independently "N seconds since midnight".
    const cases: Array<[seconds: number, expectedMinutes: number]> = [
      [120, 2], // 2.00 min -> 2
      [121, 2], // 2.016 min -> 2
      [149, 2], // 2.483 min -> 2
      [150, 3], // 2.50 min -> 3 (the exact .5 boundary rounds up)
      [151, 3], // 2.516 min -> 3
      [179, 3], // 2.983 min -> 3
      [180, 3], // 3.00 min -> 3
    ];
    for (const [seconds, expectedMinutes] of cases) {
      t.clock.set(new Date(midnight + seconds * 1000).toISOString());
      const res = await request(t.app)
        .post('/api/time-tracker')
        .set('Authorization', aliceAuth)
        .send({ category: 'WORK', durationMinutes: expectedMinutes + 1 }); // deliberately 1 over, to surface the computed window
      expect(res.status, `${seconds}s`).toBe(409);
      expect(res.body.code, `${seconds}s`).toBe('DURATION_EXCEEDS_AVAILABLE');
      expect(res.body.details, `${seconds}s`).toMatchObject({ availableMinutes: expectedMinutes });
    }
  });

  it('GAP = rounded window - entered duration, and the entered duration itself is never rounded', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    const { aliceAuth } = await setupAlice(t);
    // 150s = 2.5min -> rounds to 3 available minutes.
    t.clock.set(new Date(new Date(LOCAL_MIDNIGHT_UTC).getTime() + 150 * 1000).toISOString());
    const res = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 2 });
    expect(res.status).toBe(201);
    // window(3) = duration(2) + gap(1); TRACKER + GAP ledger rows tally with the rounded window.
    expect(res.body.data.totals).toMatchObject({ WORK: 2, BASE: 1 });
    expect(res.body.data.usedMinutes).toBe(3); // SUM OF LEDGER MINUTES
    expect(res.body.data.remainingMinutes).toBe(1437); // 1440 - USED
  });

  it('rejects category BASE (gap-only, never a tracker\'s own category), missing category, and non-positive duration', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    for (const body of [{ category: 'BASE', durationMinutes: 10 }, { durationMinutes: 10 }, { category: 'WORK', durationMinutes: 0 }, { category: 'WORK', durationMinutes: -5 }]) {
      const res = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('GET /today reflects an empty day before any tracker is added', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    const res = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(res.body.data).toMatchObject({ entries: [], usedMinutes: 0, remainingMinutes: 1440, lastTrackerTime: null, status: 'OPEN' });
  });

  it('is member-only: the admin gets 403, an unauthenticated caller gets 401', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    expect((await request(t.app).post('/api/time-tracker').set('Authorization', adminAuth).send({ category: 'WORK', durationMinutes: 10 })).status).toBe(403);
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', adminAuth)).status).toBe(403);
    expect((await request(t.app).get('/api/time-tracker/today')).status).toBe(401);
  });
});

describe('member: closing the day', () => {
  it('books whatever is left of 1440 minutes as BASE and marks the day CLOSED', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });

    const res = await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ usedMinutes: 1440, remainingMinutes: 0, status: 'CLOSED' });
    expect(res.body.data.totals.BASE).toBe(1380); // 1440 - 60
  });

  it('rejects a second close of the same day', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);
    const again = await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DAY_ALREADY_CLOSED');
  });

  it('rejects a new tracker once the day is closed', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);
    const res = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 10 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DAY_CLOSED');
  });
});

/**
 * Grabs the id of the TRACKER-type ledger row just created — same id `/api/time-tracker/:id`
 * edits/deletes. Every response is the full today(), so on a day with more than one entry
 * this must be the LAST (most recent) TRACKER row, not the first.
 */
const trackerIdOf = (today: { entries: { entryType: string; trackerId: string | null }[] }) =>
  [...today.entries].reverse().find((e) => e.entryType === 'TRACKER')!.trackerId as string;

describe('member: editing and deleting their own entries', () => {
  it('editing a smaller duration grows the paired GAP row (and creates one where there was none)', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60); // 1h window
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });
    expect(created.body.data.entries).toHaveLength(1); // exact window, no GAP yet
    const id = trackerIdOf(created.body.data);

    const edited = await request(t.app).patch(`/api/time-tracker/${id}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.totals).toMatchObject({ WORK: 40, BASE: 20 });
    expect(edited.body.data.entries).toMatchObject([
      { category: 'WORK', durationMinutes: 40, entryType: 'TRACKER' },
      { category: 'BASE', durationMinutes: 20, entryType: 'GAP' },
    ]);
  });

  it('editing back up to the full window removes the paired GAP row', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40, gapCategory: 'HEALTH' });
    expect(created.body.data.entries).toHaveLength(2);
    const id = trackerIdOf(created.body.data);

    const edited = await request(t.app).patch(`/api/time-tracker/${id}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });
    expect(edited.body.data.entries).toHaveLength(1);
    expect(edited.body.data.totals).toMatchObject({ WORK: 60, HEALTH: 0 });
  });

  it('editing category/subcategory/comment updates both the tracker and its TRACKER ledger row together', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });
    const id = trackerIdOf(created.body.data);

    const edited = await request(t.app)
      .patch(`/api/time-tracker/${id}`)
      .set('Authorization', aliceAuth)
      .send({ category: 'LEARNING', subcategory: 'Course', comment: 'Fixed the category', durationMinutes: 60 });
    expect(edited.body.data.totals).toMatchObject({ LEARNING: 60, WORK: 0 });
    expect(edited.body.data.entries).toMatchObject([{ category: 'LEARNING', subcategory: 'Course', entryType: 'TRACKER' }]);
  });

  it('rejects an edited duration greater than the entry\'s ORIGINAL window', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    const id = trackerIdOf(created.body.data);

    t.clock.advanceMinutes(600); // time passing after creation must not enlarge the entry's own fixed window
    const edited = await request(t.app).patch(`/api/time-tracker/${id}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 61 });
    expect(edited.status).toBe(409);
    expect(edited.body.code).toBe('DURATION_EXCEEDS_AVAILABLE');
    expect(edited.body.details).toMatchObject({ availableMinutes: 60 });
  });

  it('deleting an entry removes both its ledger rows and drops the totals; a sibling entry is unaffected', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const first = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    const firstId = trackerIdOf(first.body.data);
    t.clock.advanceMinutes(30);
    const second = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'HEALTH', durationMinutes: 30 });
    const secondId = trackerIdOf(second.body.data);

    const afterDelete = await request(t.app).delete(`/api/time-tracker/${firstId}`).set('Authorization', aliceAuth);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data.totals.WORK).toBe(0);
    expect(afterDelete.body.data.totals.BASE).toBe(0); // first entry's 20-min gap is gone too
    expect(afterDelete.body.data.totals.HEALTH).toBe(30); // second entry untouched

    const stillThere = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(stillThere.body.data.entries.some((e: { trackerId: string }) => e.trackerId === secondId)).toBe(true);
    expect(stillThere.body.data.entries.some((e: { trackerId: string }) => e.trackerId === firstId)).toBe(false);
  });

  it('a member cannot edit or delete another member\'s entry (reported as not-found)', async () => {
    const t = buildTestApp();
    const { adminAuth, aliceAuth } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    const bobsEntry = await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'WORK', durationMinutes: 10 });
    const id = trackerIdOf(bobsEntry.body.data);

    const edit = await request(t.app).patch(`/api/time-tracker/${id}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 5 });
    expect(edit.status).toBe(404);
    expect(edit.body.code).toBe('TRACKER_NOT_FOUND');
    const del = await request(t.app).delete(`/api/time-tracker/${id}`).set('Authorization', aliceAuth);
    expect(del.status).toBe(404);

    const bobsToday = await request(t.app).get('/api/time-tracker/today').set('Authorization', bobAuth);
    expect(bobsToday.body.data.totals.WORK).toBe(10); // untouched by alice's attempts
  });

  it('404s a malformed or unknown tracker id', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    expect((await request(t.app).patch('/api/time-tracker/not-a-uuid').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 5 })).status).toBe(400);
    expect((await request(t.app).delete('/api/time-tracker/not-a-uuid').set('Authorization', aliceAuth)).status).toBe(400);
    const missing = await request(t.app)
      .patch('/api/time-tracker/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11')
      .set('Authorization', aliceAuth)
      .send({ category: 'WORK', durationMinutes: 5 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TRACKER_NOT_FOUND');
  });

  it('rejects editing and deleting once the day is closed', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    const id = trackerIdOf(created.body.data);
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);

    const edit = await request(t.app).patch(`/api/time-tracker/${id}`).set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 10 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('DAY_CLOSED');
    const del = await request(t.app).delete(`/api/time-tracker/${id}`).set('Authorization', aliceAuth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('DAY_CLOSED');
  });
});

describe('member: fetching one tracker\'s full detail (what the edit form prefills from)', () => {
  it('GET /:id includes comment, which the today/ledger list does not carry', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    const created = await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', durationMinutes: 40 });
    const id = trackerIdOf(created.body.data);
    expect(created.body.data.entries.find((e: { entryType: string }) => e.entryType === 'TRACKER')).not.toHaveProperty('comment');

    const res = await request(t.app).get(`/api/time-tracker/${id}`).set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', durationMinutes: 40 });
  });

  it("GET /:id reflects the tracker's ACTUAL persisted gapCategory, not a hardcoded default", async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60); // 1h window
    const { aliceAuth } = await setupAlice(t);

    // Non-BASE gap category: the exact bug this test guards against — the edit
    // form must show the real saved category, not always "Base".
    const withGap = await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'HEALTH', durationMinutes: 30, gapCategory: 'PERSONAL' }); // 30 tracked, 30 leftover -> PERSONAL
    const gapId = trackerIdOf(withGap.body.data);
    const gapRes = await request(t.app).get(`/api/time-tracker/${gapId}`).set('Authorization', aliceAuth);
    expect(gapRes.body.data.gapCategory).toBe('PERSONAL');

    // Explicit/default BASE gap.
    t.clock.advanceMinutes(30);
    const withBase = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 10 }); // 20 available, 10 used -> BASE
    const baseId = trackerIdOf(withBase.body.data);
    const baseRes = await request(t.app).get(`/api/time-tracker/${baseId}`).set('Authorization', aliceAuth);
    expect(baseRes.body.data.gapCategory).toBe('BASE');

    // Zero-gap tracker: no GAP row exists at all, so gapCategory must be null, not "BASE".
    t.clock.advanceMinutes(20);
    const exact = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'LEARNING', durationMinutes: 20 }); // exact window
    const exactId = trackerIdOf(exact.body.data);
    const exactRes = await request(t.app).get(`/api/time-tracker/${exactId}`).set('Authorization', aliceAuth);
    expect(exactRes.body.data.gapCategory).toBeNull();

    // Editing without changing anything must not alter the persisted gap category.
    const noop = await request(t.app)
      .patch(`/api/time-tracker/${gapId}`)
      .set('Authorization', aliceAuth)
      .send({ category: 'HEALTH', durationMinutes: 30, gapCategory: gapRes.body.data.gapCategory });
    expect(noop.status).toBe(200);
    const afterNoop = await request(t.app).get(`/api/time-tracker/${gapId}`).set('Authorization', aliceAuth);
    expect(afterNoop.body.data.gapCategory).toBe('PERSONAL');
  });

  it('404s someone else\'s entry, an unknown id, and a malformed id', async () => {
    const t = buildTestApp();
    const { adminAuth, aliceAuth } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    const bobsEntry = await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'WORK', durationMinutes: 10 });
    const id = trackerIdOf(bobsEntry.body.data);

    expect((await request(t.app).get(`/api/time-tracker/${id}`).set('Authorization', aliceAuth)).status).toBe(404);
    expect((await request(t.app).get('/api/time-tracker/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').set('Authorization', aliceAuth)).status).toBe(404);
    expect((await request(t.app).get('/api/time-tracker/not-a-uuid').set('Authorization', aliceAuth)).status).toBe(400);
  });
});

describe('admin: time tracker across members', () => {
  it('overview returns every member\'s today, keyed by member', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30 });
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'SLEEP', durationMinutes: 45 });

    const res = await request(t.app).get('/api/admin/time-tracker').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(2);
    const forAlice = res.body.data.members.find((m: { memberId: string }) => m.memberId === alice.id);
    const forBob = res.body.data.members.find((m: { memberId: string }) => m.memberId === bob.id);
    expect(forAlice).toMatchObject({ memberName: 'Alice A', totals: { WORK: 30 } });
    expect(forBob).toMatchObject({ memberName: 'Test Member', totals: { SLEEP: 45 } });
  });

  it('GET /members/:memberId returns one member\'s full today', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30 });

    const res = await request(t.app).get(`/api/admin/time-tracker/members/${alice.id}`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ memberId: alice.id, totals: { WORK: 30, BASE: 30 } });

    const unknown = await request(t.app).get('/api/admin/time-tracker/members/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').set('Authorization', adminAuth);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('admin can edit and delete ANY member\'s entry', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    const id = trackerIdOf(created.body.data);

    const edited = await request(t.app).patch(`/api/admin/time-tracker/${id}`).set('Authorization', adminAuth).send({ category: 'HEALTH', durationMinutes: 20 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.totals).toMatchObject({ HEALTH: 20, BASE: 40 });

    const deleted = await request(t.app).delete(`/api/admin/time-tracker/${id}`).set('Authorization', adminAuth);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.entries).toHaveLength(0);
  });

  it('admin edit/delete is also blocked once that member\'s day is closed', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth } = await setupAlice(t);
    const created = await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 40 });
    const id = trackerIdOf(created.body.data);
    await request(t.app).post('/api/time-tracker/close-day').set('Authorization', aliceAuth);

    const edit = await request(t.app).patch(`/api/admin/time-tracker/${id}`).set('Authorization', adminAuth).send({ category: 'WORK', durationMinutes: 10 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('DAY_CLOSED');
  });

  it('is admin-only: a member gets 403, an unauthenticated caller gets 401', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    for (const call of [
      request(t.app).get('/api/admin/time-tracker'),
      request(t.app).get('/api/admin/time-tracker/members/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11'),
      request(t.app).patch('/api/admin/time-tracker/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11').send({ category: 'WORK', durationMinutes: 5 }),
      request(t.app).delete('/api/admin/time-tracker/0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11'),
    ]) {
      expect((await call.set('Authorization', aliceAuth)).status).toBe(403);
    }
    expect((await request(t.app).get('/api/admin/time-tracker')).status).toBe(401);
  });
});

describe('admin: activity history', () => {
  it('returns TRACKER and GAP rows for the selected date, with member identity and comment', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', durationMinutes: 40 });

    const res = await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe('2026-09-22');
    expect(res.body.data.entries).toMatchObject([
      { memberId: alice.id, memberName: 'Alice A', category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', durationMinutes: 40, entryType: 'TRACKER' },
      { memberId: alice.id, memberName: 'Alice A', category: 'BASE', comment: null, durationMinutes: 20, entryType: 'GAP' },
    ]);
    expect(res.body.data.summary).toMatchObject({ memberCount: 1, trackedMinutes: 40, entryCount: 2 });
    expect(res.body.data.memberSummary).toBeNull(); // no memberId filter applied
  });

  it('filters by memberId, category, and both together', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(120);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30 });
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'SLEEP', durationMinutes: 45 });

    const byMember = await request(t.app).get(`/api/admin/time-tracker/history?date=2026-09-22&memberId=${alice.id}`).set('Authorization', adminAuth);
    expect(byMember.body.data.entries.every((e: { memberId: string }) => e.memberId === alice.id)).toBe(true);
    expect(byMember.body.data.memberSummary).toMatchObject({ memberId: alice.id, memberName: 'Alice A' });

    const byCategory = await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22&category=SLEEP').set('Authorization', adminAuth);
    expect(byCategory.body.data.entries).toMatchObject([{ memberId: bob.id, category: 'SLEEP' }]);

    const byBoth = await request(t.app).get(`/api/admin/time-tracker/history?date=2026-09-22&memberId=${alice.id}&category=SLEEP`).set('Authorization', adminAuth);
    expect(byBoth.body.data.entries).toHaveLength(0);
    expect(byBoth.body.data.summary).toMatchObject({ memberCount: 0, trackedMinutes: 0, entryCount: 0 });
  });

  it('returns an empty result for a date with no activity', async () => {
    const t = buildTestApp();
    const { adminAuth } = await setupAlice(t);
    const res = await request(t.app).get('/api/admin/time-tracker/history?date=2020-01-01').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ date: '2020-01-01', entries: [], summary: { memberCount: 0, trackedMinutes: 0, entryCount: 0 } });
  });

  it('rejects a missing or malformed date, and an unknown memberId', async () => {
    const t = buildTestApp();
    const { adminAuth } = await setupAlice(t);
    expect((await request(t.app).get('/api/admin/time-tracker/history').set('Authorization', adminAuth)).status).toBe(400);
    expect((await request(t.app).get('/api/admin/time-tracker/history?date=21-09-2026').set('Authorization', adminAuth)).status).toBe(400);
    expect((await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22&memberId=not-a-uuid').set('Authorization', adminAuth)).status).toBe(400);

    const unknownMember = await request(t.app)
      .get('/api/admin/time-tracker/history?date=2026-09-22&memberId=0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11')
      .set('Authorization', adminAuth);
    expect(unknownMember.status).toBe(404);
    expect(unknownMember.body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('is admin-only: a member gets 403, an unauthenticated caller gets 401', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    expect((await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22').set('Authorization', aliceAuth)).status).toBe(403);
    expect((await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22')).status).toBe(401);
  });

  it("does not affect today's own tracker flow or calculations", async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });

    await request(t.app).get('/api/admin/time-tracker/history?date=2026-09-22').set('Authorization', adminAuth);

    const today = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(today.body.data).toMatchObject({ totals: { WORK: 60, BASE: 0 }, usedMinutes: 60, remainingMinutes: 1380, status: 'OPEN' });
  });
});

describe('member: own activity history', () => {
  it('rejects an impossible calendar date instead of silently querying the wrong day (member + admin routes)', async () => {
    const t = buildTestApp();
    const { adminAuth, aliceAuth } = await setupAlice(t);
    expect((await request(t.app).get('/api/time-tracker/history?date=2026-02-30').set('Authorization', aliceAuth)).status).toBe(400);
    expect((await request(t.app).get('/api/admin/time-tracker/history?date=2026-02-30').set('Authorization', adminAuth)).status).toBe(400);
  });

  it("returns only the authenticated member's own entries, with an always-present daily summary", async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    await request(t.app)
      .post('/api/time-tracker')
      .set('Authorization', aliceAuth)
      .send({ category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', durationMinutes: 40 });
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'SLEEP', durationMinutes: 45 });

    const res = await request(t.app).get('/api/time-tracker/history?date=2026-09-22').set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.every((e: { memberId: string }) => e.memberId === alice.id)).toBe(true);
    expect(res.body.data.entries).toMatchObject([
      { category: 'WORK', subcategory: 'Development', comment: 'Fixed the bug', entryType: 'TRACKER' },
      { category: 'BASE', comment: null, entryType: 'GAP' },
    ]);
    // Unlike admin (where memberSummary is opt-in via ?memberId=), a member's own
    // history is always scoped to exactly one member, so it's always populated.
    expect(res.body.data.memberSummary).toMatchObject({ memberId: alice.id, memberName: 'Alice A', usedMinutes: 60 }); // 40 tracked + 20 GAP (60-minute window)
  });

  it("a memberId on the query string is ignored — it can never be used to read another member's history", async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { adminAuth, aliceAuth, alice } = await setupAlice(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'SLEEP', durationMinutes: 45 });

    // Alice tries to smuggle Bob's id in as `memberId` — the schema has no such
    // field, so it's stripped before the controller ever sees it.
    const res = await request(t.app).get(`/api/time-tracker/history?date=2026-09-22&memberId=${bob.id}`).set('Authorization', aliceAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0); // alice has no entries that day — NOT bob's
    expect(res.body.data.memberSummary).toMatchObject({ memberId: alice.id });
  });

  it('filters by category', async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(120);
    const { aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 30 });
    t.clock.advanceMinutes(30);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'HEALTH', durationMinutes: 20 });

    const res = await request(t.app).get('/api/time-tracker/history?date=2026-09-22&category=HEALTH').set('Authorization', aliceAuth);
    expect(res.body.data.entries).toMatchObject([{ category: 'HEALTH', entryType: 'TRACKER' }]);
  });

  it('is member-only: the admin gets 403, an unauthenticated caller gets 401', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    expect((await request(t.app).get('/api/time-tracker/history?date=2026-09-22').set('Authorization', adminAuth)).status).toBe(403);
    expect((await request(t.app).get('/api/time-tracker/history?date=2026-09-22')).status).toBe(401);
  });

  it('rejects a missing or malformed date', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    expect((await request(t.app).get('/api/time-tracker/history').set('Authorization', aliceAuth)).status).toBe(400);
    expect((await request(t.app).get('/api/time-tracker/history?date=22-09-2026').set('Authorization', aliceAuth)).status).toBe(400);
  });

  it("does not affect today's own tracker flow or calculations", async () => {
    const t = buildTestApp(LOCAL_MIDNIGHT_UTC);
    t.clock.advanceMinutes(60);
    const { aliceAuth } = await setupAlice(t);
    await request(t.app).post('/api/time-tracker').set('Authorization', aliceAuth).send({ category: 'WORK', durationMinutes: 60 });

    await request(t.app).get('/api/time-tracker/history?date=2026-09-22').set('Authorization', aliceAuth);

    const today = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(today.body.data).toMatchObject({ totals: { WORK: 60, BASE: 0 }, usedMinutes: 60, remainingMinutes: 1380, status: 'OPEN' });
  });
});
