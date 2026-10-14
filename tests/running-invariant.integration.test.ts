/**
 * Real-database tests: table relationships and invariants Prisma's schema
 * language can't express (CHECK constraints, FK-restrict, the (member_id, date)
 * uniqueness that makes day-closing idempotent).
 * Opt-in — point TEST_DATABASE_URL at a MIGRATED, DISPOSABLE database:
 *   TEST_DATABASE_URL=postgresql://... npm test
 * It deletes every row in members, departments, tasks, time_tracker, time_ledger and daily_closure.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, DB_SESSION_OPTIONS } from '../src/config/database';
import { PrismaAttachmentRepository } from '../src/modules/attachment/attachment.repository';
import { PrismaDepartmentRepository } from '../src/modules/department/department.repository';
import { PrismaMemberRepository } from '../src/modules/member/member.repository';
import { PrismaTaskRepository } from '../src/modules/task/task.repository';
import { PrismaTimeTrackerRepository } from '../src/modules/time-tracker/time-tracker.repository';
import { TimeTrackerService } from '../src/modules/time-tracker/time-tracker.service';
import { FakeClock } from './helpers/fake-clock';

const url = process.env['TEST_DATABASE_URL'];
const TIMEZONE = 'Asia/Kolkata';
// Local midnight (IST) for 2026-09-22.
const LOCAL_MIDNIGHT = '2026-09-21T18:30:00.000Z';

describe.skipIf(!url)('database: relationships and invariants', () => {
  const db = createDatabase(url ?? 'postgresql://unused');
  const members = new PrismaMemberRepository(db);
  const trackerRepo = new PrismaTimeTrackerRepository(db);
  const clock = new FakeClock(new Date(LOCAL_MIDNIGHT));
  const tasks = new PrismaTaskRepository(db);
  const service = new TimeTrackerService(trackerRepo, members, tasks, clock, TIMEZONE);

  const wipe = async () => {
    await db.requestAttachment.deleteMany();
    await db.timeLedgerEntry.deleteMany();
    await db.dailyClosure.deleteMany();
    await db.timeTrackerEntry.deleteMany();
    await db.departmentRequest.deleteMany();
    await db.task.deleteMany();
    await db.member.deleteMany();
    await db.department.deleteMany();
  };
  const newMember = (username: string) =>
    db.member.create({ data: { username, fullName: `Member ${username}`, passwordHash: '$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234' } });

  beforeEach(async () => {
    await wipe();
    clock.set(LOCAL_MIDNIGHT);
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('computes the gap since local midnight for the first tracker of the day (real DB)', async () => {
    const m = await newMember('alice');
    clock.advanceMinutes(9 * 60); // 09:00 IST
    const today = await service.create(m.id, { category: 'SLEEP', durationMinutes: 480, subcategory: undefined, comment: undefined, gapCategory: undefined });
    expect(today.totals).toMatchObject({ SLEEP: 480, BASE: 60 });
    expect(today.usedMinutes).toBe(540);
  });

  it('rejects a duration greater than the available window (real DB)', async () => {
    const m = await newMember('alice');
    clock.advanceMinutes(60);
    await expect(
      service.create(m.id, { category: 'WORK', durationMinutes: 90, subcategory: undefined, comment: undefined, gapCategory: undefined }),
    ).rejects.toMatchObject({ code: 'DURATION_EXCEEDS_AVAILABLE' });
  });

  it('closing the day is idempotent under concurrency: exactly one of 5 concurrent closes wins (real DB)', async () => {
    const m = await newMember('alice');
    clock.advanceMinutes(60);
    await service.create(m.id, { category: 'WORK', durationMinutes: 60, subcategory: undefined, comment: undefined, gapCategory: undefined });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.closeDay(m.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'DAY_ALREADY_CLOSED' });
    }
    // Exactly one BASE-remainder row from closing, not five.
    expect(await db.timeLedgerEntry.count({ where: { memberId: m.id, trackerId: null } })).toBe(1);
    expect(await db.dailyClosure.count({ where: { memberId: m.id } })).toBe(1);
  });

  it('deleting a member removes them and only their own tasks, time, ledger rows and closures (real DB)', async () => {
    const dept = await newDepartment('Fintech');
    const tracked = await newMemberIn('alice', dept.id);
    const other = await newMemberIn('dave', dept.id);
    const task = await newTask(dept.id, tracked.id);
    clock.advanceMinutes(30);
    await service.create(tracked.id, { category: 'WORK', durationMinutes: 30, taskId: task.id, ...noExtras });
    await service.create(other.id, { category: 'SLEEP', durationMinutes: 30, ...noExtras });
    await service.closeDay(tracked.id);

    expect(await members.impact(tracked.id)).toEqual({ tasks: 1, timeEntries: 1, closedDays: 1 });
    expect(await members.impact('0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11')).toBeNull();
    await expect(members.remove(tracked.id)).resolves.toBe(true);
    expect(await db.member.findUnique({ where: { id: tracked.id } })).toBeNull();
    expect(await db.task.count({ where: { memberId: tracked.id } })).toBe(0);
    expect(await db.timeTrackerEntry.count({ where: { memberId: tracked.id } })).toBe(0);
    expect(await db.timeLedgerEntry.count({ where: { memberId: tracked.id } })).toBe(0);
    expect(await db.dailyClosure.count({ where: { memberId: tracked.id } })).toBe(0);
    // the other member is untouched
    expect(await db.timeTrackerEntry.count({ where: { memberId: other.id } })).toBe(1);
    expect(await db.timeLedgerEntry.count({ where: { memberId: other.id } })).toBeGreaterThan(0);

    const fresh = await newMember('carol');
    await expect(members.remove(fresh.id)).resolves.toBe(true);
    expect(await db.member.findUnique({ where: { id: fresh.id } })).toBeNull();
    expect(await members.remove(fresh.id)).toBe(false); // already gone
  });

  it('enforces foreign keys: no orphan ledger/tracker rows for a member that does not exist', async () => {
    await expect(
      db.timeTrackerEntry.create({
        data: {
          memberId: '0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11',
          date: new Date('2026-09-22'),
          category: 'WORK',
          durationMinutes: 10,
          previousTrackerTime: new Date(),
          trackerTime: new Date(),
          gapMinutes: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects duplicate and non-lower-case usernames at the database level', async () => {
    await newMember('alice');
    await expect(newMember('alice')).rejects.toThrow();
    await expect(newMember('Bob')).rejects.toThrow(); // members_username_lowercase_chk
  });

  it('rejects non-positive durations and a negative gap at the database level', async () => {
    const m = await newMember('alice');
    const base = {
      memberId: m.id,
      date: new Date('2026-09-22'),
      category: 'WORK' as const,
      previousTrackerTime: new Date(LOCAL_MIDNIGHT),
      trackerTime: new Date(LOCAL_MIDNIGHT),
    };
    await expect(db.timeTrackerEntry.create({ data: { ...base, durationMinutes: 0, gapMinutes: 0 } })).rejects.toThrow(); // duration > 0
    await expect(db.timeTrackerEntry.create({ data: { ...base, durationMinutes: 10, gapMinutes: -1 } })).rejects.toThrow(); // gap >= 0
    await expect(
      db.timeLedgerEntry.create({ data: { memberId: m.id, date: base.date, category: 'BASE', durationMinutes: 0, entryType: 'GAP' } }),
    ).rejects.toThrow(); // duration > 0
  });

  it('editing an entry (real DB): the tracker row, its TRACKER ledger row and its paired GAP row all update atomically', async () => {
    const m = await newMember('alice');
    clock.advanceMinutes(60);
    const created = await service.create(m.id, { category: 'WORK', durationMinutes: 40, subcategory: undefined, comment: undefined, gapCategory: undefined });
    const id = created.entries.find((e) => e.entryType === 'TRACKER')!.trackerId!;
    expect(await db.timeLedgerEntry.count({ where: { trackerId: id } })).toBe(2); // TRACKER + GAP(20)

    const edited = await service.update({ role: 'member', memberId: m.id }, id, {
      category: 'HEALTH',
      subcategory: undefined,
      comment: undefined,
      durationMinutes: 60,
      gapCategory: undefined,
    });
    expect(edited.totals).toMatchObject({ HEALTH: 60, WORK: 0, BASE: 0 });
    // Growing the duration to the full window removed the now-zero GAP row.
    expect(await db.timeLedgerEntry.count({ where: { trackerId: id } })).toBe(1);
    expect(await db.timeTrackerEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({ category: 'HEALTH', durationMinutes: 60, gapMinutes: 0 });
  });

  it('an admin actor can edit/delete any member\'s entry; a member actor cannot touch another member\'s (real DB)', async () => {
    const alice = await newMember('alice');
    clock.advanceMinutes(60);
    const created = await service.create(alice.id, { category: 'WORK', durationMinutes: 40, subcategory: undefined, comment: undefined, gapCategory: undefined });
    const id = created.entries.find((e) => e.entryType === 'TRACKER')!.trackerId!;

    const bob = await newMember('bob');
    await expect(
      service.update({ role: 'member', memberId: bob.id }, id, { category: 'WORK', subcategory: undefined, comment: undefined, durationMinutes: 1, gapCategory: undefined }),
    ).rejects.toMatchObject({ code: 'TRACKER_NOT_FOUND' });

    const asAdmin = await service.update({ role: 'admin', scope: { kind: 'all' } }, id, { category: 'PERSONAL', subcategory: undefined, comment: undefined, durationMinutes: 40, gapCategory: undefined });
    expect(asAdmin.totals).toMatchObject({ PERSONAL: 40 });

    await service.remove({ role: 'admin', scope: { kind: 'all' } }, id);
    expect(await db.timeTrackerEntry.findUnique({ where: { id } })).toBeNull();
    expect(await db.timeLedgerEntry.count({ where: { trackerId: id } })).toBe(0);
  });

  it('overview (real DB) returns one today() per member with no admin-visibility gaps', async () => {
    const alice = await newMember('alice');
    const bob = await newMember('bob');
    clock.advanceMinutes(60);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 20, subcategory: undefined, comment: undefined, gapCategory: undefined });
    await service.create(bob.id, { category: 'SLEEP', durationMinutes: 30, subcategory: undefined, comment: undefined, gapCategory: undefined });

    const overview = await service.overview({ kind: 'all' });
    expect(overview).toHaveLength(2);
    expect(overview.find((o) => o.memberId === alice.id)).toMatchObject({ totals: { WORK: 20 } });
    expect(overview.find((o) => o.memberId === bob.id)).toMatchObject({ totals: { SLEEP: 30 } });
  });

  it('the (member_id, date) uniqueness on daily_closure is enforced at the database level, independent of the service', async () => {
    const m = await newMember('alice');
    await db.dailyClosure.create({ data: { memberId: m.id, date: new Date('2026-09-22') } });
    await expect(db.dailyClosure.create({ data: { memberId: m.id, date: new Date('2026-09-22') } })).rejects.toThrow();
    // A different date for the same member is fine.
    await expect(db.dailyClosure.create({ data: { memberId: m.id, date: new Date('2026-09-23') } })).resolves.toBeTruthy();
  });

  // ── departments / tasks / the task link ──
  const newDepartment = (name: string) => db.department.create({ data: { name } });
  const newMemberIn = (username: string, departmentId: string) =>
    db.member.create({ data: { username, fullName: `Member ${username}`, memberships: { create: { departmentId } }, passwordHash: '$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234' } });
  const newTask = (departmentId: string, memberId: string, title = 'Payment module') =>
    db.task.create({ data: { title, departmentId, memberId, createdBy: 'admin' } });
  const noExtras = { subcategory: undefined, comment: undefined, gapCategory: undefined } as const;

  it('logs time against a task and reads the task back through the real joins; the ledger maths is identical (real DB)', async () => {
    const dept = await newDepartment('Fintech');
    const alice = await newMemberIn('alice', dept.id);
    const task = await newTask(dept.id, alice.id);
    clock.advanceMinutes(60);

    const today = await service.create(alice.id, { category: 'WORK', durationMinutes: 40, taskId: task.id, ...noExtras });
    expect(today.entries).toMatchObject([
      { entryType: 'TRACKER', taskId: task.id, taskTitle: 'Payment module' },
      { entryType: 'GAP', taskId: null, taskTitle: null },
    ]);
    expect(today).toMatchObject({ totals: { WORK: 40, BASE: 20 }, usedMinutes: 60, remainingMinutes: 1380 });
    expect((await db.timeTrackerEntry.findFirstOrThrow({ where: { memberId: alice.id } })).taskId).toBe(task.id);
  });

  it("refuses another member's task, and never writes anything for a refused attempt (real DB)", async () => {
    const dept = await newDepartment('Fintech');
    const alice = await newMemberIn('alice', dept.id);
    const bob = await newMemberIn('bob', dept.id);
    const bobsTask = await newTask(dept.id, bob.id);
    clock.advanceMinutes(60);

    await expect(service.create(alice.id, { category: 'WORK', durationMinutes: 10, taskId: bobsTask.id, ...noExtras })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(await db.timeTrackerEntry.count()).toBe(0);
    expect(await db.timeLedgerEntry.count()).toBe(0);
  });

  it('foreign keys are RESTRICT: a referenced task / department / member department cannot be deleted (real DB)', async () => {
    const dept = await newDepartment('Fintech');
    const alice = await newMemberIn('alice', dept.id);
    const task = await newTask(dept.id, alice.id);
    clock.advanceMinutes(60);
    const today = await service.create(alice.id, { category: 'WORK', durationMinutes: 40, taskId: task.id, ...noExtras });
    const trackerId = today.entries.find((e) => e.entryType === 'TRACKER')!.trackerId!;

    // the database itself refuses to drop a referenced task if the app layer were bypassed
    await expect(db.task.delete({ where: { id: task.id } })).rejects.toThrow();
    await expect(db.department.delete({ where: { id: dept.id } })).rejects.toThrow(); // members + tasks reference it

    // the repository's delete unlinks the entry (keeping every minute) and removes the task in one transaction
    await expect(tasks.remove(task.id)).resolves.toBe(true);
    const entry = await db.timeTrackerEntry.findUnique({ where: { id: trackerId } });
    expect(entry).toMatchObject({ taskId: null, durationMinutes: 40 });
    expect(await db.timeLedgerEntry.count({ where: { trackerId } })).toBeGreaterThan(0);
    await expect(tasks.remove(task.id)).resolves.toBe(false);
    // memberships are not a restriction any more: they simply go with the department (the member stays)
    await service.remove({ role: 'admin', scope: { kind: 'all' } }, trackerId); // the member is still held by their time entry until it goes
    await expect(db.department.delete({ where: { id: dept.id } })).resolves.toBeTruthy();
    expect(await db.memberDepartment.count({ where: { memberId: alice.id } })).toBe(0);
    expect(await db.member.findUnique({ where: { id: alice.id } })).not.toBeNull();
  });

  it('CHECK constraints reject a blank department name and a blank task title, and department names are unique (real DB)', async () => {
    await expect(db.department.create({ data: { name: '   ' } })).rejects.toThrow();
    const dept = await newDepartment('Fintech');
    await expect(db.department.create({ data: { name: 'Fintech' } })).rejects.toThrow();
    const alice = await newMemberIn('alice', dept.id);
    await expect(db.task.create({ data: { title: '   ', departmentId: dept.id, memberId: alice.id, createdBy: 'admin' } })).rejects.toThrow();
  });

  it('activity history: department roster AND member filter combine in SQL, and only a TRACKER row carries the task (real DB)', async () => {
    const fintech = await newDepartment('Fintech');
    const studio = await newDepartment('Studio');
    const alice = await newMemberIn('alice', fintech.id);
    const bob = await newMemberIn('bob', fintech.id);
    const carol = await newMemberIn('carol', studio.id);
    const task = await newTask(fintech.id, alice.id);
    clock.advanceMinutes(60);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 30, taskId: task.id, ...noExtras });
    await service.create(bob.id, { category: 'SLEEP', durationMinutes: 30, ...noExtras });
    await service.create(carol.id, { category: 'LEARNING', durationMinutes: 30, ...noExtras });

    const date = '2026-09-22';
    const names = async (filters: { departmentId?: string; memberId?: string }) =>
      new Set((await service.activityHistory({ kind: 'all' }, { date, ...filters })).entries.map((e) => e.memberName));

    // (The service resolves a department to its roster through the member repository.)
    expect(await names({})).toEqual(new Set(['Member alice', 'Member bob', 'Member carol']));
    expect(await names({ departmentId: fintech.id })).toEqual(new Set(['Member alice', 'Member bob']));
    expect(await names({ departmentId: studio.id })).toEqual(new Set(['Member carol']));
    expect(await names({ departmentId: fintech.id, memberId: bob.id })).toEqual(new Set(['Member bob']));
    expect(await names({ departmentId: fintech.id, memberId: carol.id })).toEqual(new Set());

    const all = await service.activityHistory({ kind: 'all' }, { date });
    const aliceRows = all.entries.filter((e) => e.memberId === alice.id);
    expect(aliceRows.find((e) => e.entryType === 'TRACKER')?.taskTitle).toBe('Payment module');
    expect(aliceRows.filter((e) => e.entryType === 'GAP').every((e) => e.taskTitle === null)).toBe(true);
  });
  it('task progress in SQL: logging starts a To-do task, minutes total per task, completed_at is stamped and cleared (real DB)', async () => {
    const dept = await newDepartment('Fintech');
    const alice = await newMemberIn('alice', dept.id);
    const task = await newTask(dept.id, alice.id);
    clock.advanceMinutes(60);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 40, taskId: task.id, ...noExtras }); // 60 window → 20 gap
    clock.advanceMinutes(30);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 10, taskId: task.id, ...noExtras });

    expect((await tasks.findById(task.id))?.status).toBe('IN_PROGRESS');
    expect((await tasks.loggedMinutes([task.id])).get(task.id)).toBe(50); // tracked time only, never the gap
    expect((await tasks.loggedMinutes([])).size).toBe(0);

    const done = await tasks.update(task.id, { status: 'DONE' });
    expect(done?.completedAt).toBeInstanceOf(Date);
    const again = await tasks.update(task.id, { status: 'DONE' });
    expect(again?.completedAt?.getTime()).toBe(done?.completedAt?.getTime());
    expect((await tasks.update(task.id, { status: 'TODO' }))?.completedAt).toBeNull();
    expect(await tasks.update('0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11', { status: 'DONE' })).toBeNull();
  });

  it('deleting a department deletes its members with all their data and its tasks, and nothing else, in one transaction (real DB)', async () => {
    const departmentsRepo = new PrismaDepartmentRepository(db);
    const fintech = await newDepartment('Fintech');
    const studio = await newDepartment('Studio');
    const alice = await newMemberIn('alice', fintech.id);
    const carol = await newMemberIn('carol', studio.id);
    const doomed = await newTask(fintech.id, alice.id);
    const safe = await newTask(studio.id, carol.id);
    // a member who has since moved to Studio still owns a task filed under Fintech
    const moved = await newMemberIn('moved', studio.id);
    const strayTask = await newTask(fintech.id, moved.id);
    clock.advanceMinutes(60);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 40, taskId: doomed.id, ...noExtras });
    await service.create(carol.id, { category: 'WORK', durationMinutes: 20, taskId: safe.id, ...noExtras });
    await service.create(moved.id, { category: 'WORK', durationMinutes: 10, taskId: strayTask.id, ...noExtras });
    await service.closeDay(alice.id);

    expect(await departmentsRepo.impact(fintech.id)).toEqual({ members: 1, keptMembers: 0, tasks: 2, timeEntries: 1, closedDays: 1 });
    expect(await departmentsRepo.impact('0195f3a2-7c1e-7a55-9c39-0d0c8b1f3e11')).toBeNull();

    await expect(departmentsRepo.remove(fintech.id)).resolves.toBe(true);
    expect(await db.department.findUnique({ where: { id: fintech.id } })).toBeNull();
    expect(await db.member.findUnique({ where: { id: alice.id } })).toBeNull();
    expect(await db.task.count({ where: { id: { in: [doomed.id, strayTask.id] } } })).toBe(0);
    expect(await db.timeTrackerEntry.count({ where: { memberId: alice.id } })).toBe(0);
    expect(await db.timeLedgerEntry.count({ where: { memberId: alice.id } })).toBe(0);
    expect(await db.dailyClosure.count({ where: { memberId: alice.id } })).toBe(0);
    // the member who moved keeps their account and their 10 minutes — only the task link is gone
    expect(await db.member.findUnique({ where: { id: moved.id } })).not.toBeNull();
    expect(await db.timeTrackerEntry.findFirst({ where: { memberId: moved.id } })).toMatchObject({ taskId: null, durationMinutes: 10 });
    // the other department, its member, task and time are untouched
    expect(await db.task.findUnique({ where: { id: safe.id } })).not.toBeNull();
    expect((await db.timeTrackerEntry.findFirst({ where: { memberId: carol.id } }))?.taskId).toBe(safe.id);
    await expect(departmentsRepo.remove(fintech.id)).resolves.toBe(false);
  });

  it('a member belongs to 1..2 departments: the trigger refuses a third, list/update follow the memberships (real DB)', async () => {
    const [a, b, c] = [await newDepartment('A'), await newDepartment('B'), await newDepartment('C')];
    const hash = '$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234';
    const dave = await members.create({ username: 'dave@x.com', fullName: 'Dave', passwordHash: hash, departmentIds: [a.id, b.id] });
    expect(dave.departmentIds.sort()).toEqual([a.id, b.id].sort());
    await expect(db.memberDepartment.create({ data: { memberId: dave.id, departmentId: c.id } })).rejects.toThrow(/at most 2 departments/); // the database itself
    await expect(members.update(dave.id, { departmentIds: [a.id, b.id, c.id] })).rejects.toThrow();
    expect((await members.findById(dave.id))?.departmentIds.sort()).toEqual([a.id, b.id].sort()); // the refused update changed nothing

    expect((await members.list({ departmentId: a.id })).map((m) => m.id)).toEqual([dave.id]);
    expect((await members.list({ departmentId: b.id })).map((m) => m.id)).toEqual([dave.id]);
    expect((await members.update(dave.id, { departmentIds: [b.id, c.id] }))?.departmentIds.sort()).toEqual([b.id, c.id].sort()); // replaced
    expect(await members.list({ departmentId: a.id })).toEqual([]);
    await expect(db.memberDepartment.create({ data: { memberId: dave.id, departmentId: b.id } })).rejects.toThrow(); // no duplicates
  });

  it('deleting a department keeps a member who is also elsewhere (only the membership goes) and deletes its leader and exclusive members (real DB)', async () => {
    const departmentsRepo = new PrismaDepartmentRepository(db);
    const fintech = await newDepartment('Fintech');
    const studio = await newDepartment('Studio');
    const hash = '$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234';
    const leader = await newMemberIn('lead', studio.id);
    await departmentsRepo.assignLeader(studio.id, leader.id);
    const carol = await newMemberIn('carol', studio.id);
    const dave = await members.create({ username: 'dave@x.com', fullName: 'Dave', passwordHash: hash, departmentIds: [fintech.id, studio.id] });
    const studioTask = await newTask(studio.id, dave.id, 'Studio banner');
    const fintechTask = await newTask(fintech.id, dave.id, 'Fintech report');
    clock.advanceMinutes(60);
    await service.create(dave.id, { category: 'WORK', durationMinutes: 30, taskId: studioTask.id, ...noExtras });
    clock.advanceMinutes(30);
    await service.create(dave.id, { category: 'WORK', durationMinutes: 20, taskId: fintechTask.id, ...noExtras });
    await service.create(carol.id, { category: 'WORK', durationMinutes: 10, ...noExtras }).catch(() => undefined);

    expect(await departmentsRepo.impact(studio.id)).toMatchObject({ members: 2, keptMembers: 1 }); // carol + the leader go; dave stays
    await expect(departmentsRepo.remove(studio.id)).resolves.toBe(true);

    expect(await db.member.findUnique({ where: { id: leader.id } })).toBeNull();
    expect(await db.member.findUnique({ where: { id: carol.id } })).toBeNull();
    expect(await db.member.findUnique({ where: { id: dave.id } })).not.toBeNull();
    expect((await members.findById(dave.id))?.departmentIds).toEqual([fintech.id]); // his other membership is untouched
    expect(await db.task.findUnique({ where: { id: studioTask.id } })).toBeNull();
    expect(await db.task.findUnique({ where: { id: fintechTask.id } })).not.toBeNull();
    // his 30 minutes on the deleted task are kept, unlinked; the other 20 still point at their task
    const entries = await db.timeTrackerEntry.findMany({ where: { memberId: dave.id }, orderBy: { createdAt: 'asc' } });
    expect(entries.map((e) => [e.durationMinutes, e.taskId])).toEqual([[30, null], [20, fintechTask.id]]);
    expect(await db.department.findUnique({ where: { id: fintech.id } })).not.toBeNull();
  });

  it('the database allows only one running stopwatch per member, and saving time against the task ends it (real DB)', async () => {
    const dept = await newDepartment('Fintech');
    const alice = await newMemberIn('alice', dept.id);
    const one = await newTask(dept.id, alice.id);
    const two = await newTask(dept.id, alice.id);
    await tasks.update(one.id, { timerStartedAt: new Date() });
    await expect(tasks.update(two.id, { timerStartedAt: new Date() })).rejects.toMatchObject({ code: 'TIMER_ALREADY_RUNNING' });

    clock.advanceMinutes(60);
    await service.create(alice.id, { category: 'WORK', durationMinutes: 30, taskId: one.id, ...noExtras });
    expect((await tasks.findById(one.id))?.timerStartedAt).toBeNull();
    await expect(tasks.update(two.id, { timerStartedAt: new Date() })).resolves.toBeTruthy();

    // finishing a task clears its stopwatch in SQL too
    expect((await tasks.update(two.id, { status: 'DONE' }))?.timerStartedAt).toBeNull();
  });
  it('roles in SQL: one leader per department, an Admin leads one department, and requests cascade with their ends (real DB)', async () => {
    const fintech = await newDepartment('Fintech');
    const studio = await newDepartment('Studio');
    const deptRepo = new PrismaDepartmentRepository(db);
    // Promoting an existing member: role flips to ADMIN, their memberships are cleared (an Admin's
    // "departments" = the one they lead), and the department now has that leader.
    const lead = await newMemberIn('lead', fintech.id);
    await deptRepo.assignLeader(fintech.id, lead.id);
    expect((await members.findById(lead.id))?.role).toBe('ADMIN');
    expect((await members.findLeader(fintech.id))?.id).toBe(lead.id);
    expect((await members.findById(lead.id))?.departmentIds).toEqual([fintech.id]);

    // Assigning a DIFFERENT member as the same department's leader changes it: the old leader is
    // demoted back to a plain member with no department (one leader per department, always).
    const lead3 = await newMemberIn('lead3', fintech.id);
    await deptRepo.assignLeader(fintech.id, lead3.id);
    expect((await members.findById(lead.id))?.role).toBe('MEMBER');
    expect((await members.findById(lead.id))?.departmentIds).toEqual([]);
    expect((await members.findLeader(fintech.id))?.id).toBe(lead3.id);

    const lead2 = await newMemberIn('lead2', studio.id);
    await deptRepo.assignLeader(studio.id, lead2.id);
    // An Admin leads at most one department — the service checks this (MEMBER_ALREADY_LEADER)
    // before ever reaching SQL; the UNIQUE leader_id column is the backstop for a race.
    const ops = await newDepartment('Ops');
    await expect(deptRepo.assignLeader(ops.id, lead3.id)).rejects.toMatchObject({ code: 'MEMBER_ALREADY_LEADER' });
    expect((await members.findById(lead3.id))?.departmentIds).toEqual([fintech.id]); // untouched by the failed attempt
    expect((await members.list({ departmentId: studio.id })).map((m) => m.id)).toEqual([lead2.id]);

    // Removing a leader demotes them back to a plain member with no department.
    await deptRepo.removeLeader(studio.id);
    expect((await members.findById(lead2.id))?.role).toBe('MEMBER');
    expect((await members.findLeader(studio.id))).toBeNull();
    await deptRepo.assignLeader(studio.id, lead2.id); // it can be given a leader again afterward

    const alice = await newMemberIn('alice', studio.id);
    const req = await db.departmentRequest.create({ data: { fromMemberId: alice.id, toDepartmentId: fintech.id, subject: 'Need', message: 'Please' } });
    expect(req.status).toBe('OPEN');
    await expect(db.departmentRequest.create({ data: { fromMemberId: alice.id, toDepartmentId: fintech.id, subject: '  ', message: 'x' } })).rejects.toThrow(); // blank subject
    await members.remove(alice.id);
    expect(await db.departmentRequest.count()).toBe(0); // gone with its sender

    const bob = await newMemberIn('bob', studio.id);
    await db.departmentRequest.create({ data: { fromMemberId: bob.id, toDepartmentId: fintech.id, subject: 'Again', message: 'Please' } });
    await new PrismaDepartmentRepository(db).remove(fintech.id);
    expect(await db.departmentRequest.count()).toBe(0); // gone with its receiving department
    expect(await db.member.findUnique({ where: { id: bob.id } })).not.toBeNull(); // the sender is untouched
  });
  it('timestamps are stored as the TRUE UTC instant even when the server is set to another timezone (real DB)', async () => {
    // Reproduce the old failure mode: a server whose default timezone is not UTC.
    const dbName = (await db.$queryRawUnsafe<{ n: string }[]>('select current_database() as n'))[0]!.n;
    await db.$executeRawUnsafe(`ALTER DATABASE "${dbName}" SET timezone TO 'Asia/Kolkata'`);
    const fresh = createDatabase(url!); // new pool → new connections pick up the server default unless the app pins UTC
    try {
      expect(DB_SESSION_OPTIONS).toContain('UTC');
      const session = await fresh.$queryRawUnsafe<{ tz: string }[]>("select current_setting('TimeZone') as tz");
      expect(session[0]!.tz).toBe('UTC'); // pinned by the app, not inherited from the server

      const instant = new Date('2026-09-26T12:30:15.000Z');
      const dept = await fresh.department.create({ data: { name: 'TZ check', createdAt: instant } });
      // What PostgreSQL holds, read back independently of Prisma: seconds since the epoch of the stored instant.
      const raw = await fresh.$queryRawUnsafe<{ epoch: string }[]>(`select extract(epoch from created_at)::text as epoch from departments where id = '${dept.id}'`);
      expect(Number(raw[0]!.epoch)).toBe(instant.getTime() / 1000); // not shifted by 5h30
      expect((await fresh.department.findUnique({ where: { id: dept.id } }))?.createdAt.toISOString()).toBe(instant.toISOString());
      // A default (now()) is the real instant too, to within the test's runtime.
      const other = await fresh.department.create({ data: { name: 'TZ now' } });
      const drift = await fresh.$queryRawUnsafe<{ s: string }[]>(`select abs(extract(epoch from now() - created_at))::text as s from departments where id = '${other.id}'`);
      expect(Number(drift[0]!.s)).toBeLessThan(60);
    } finally {
      await fresh.$disconnect();
      await db.$executeRawUnsafe(`ALTER DATABASE "${dbName}" RESET timezone`);
    }
  });
});

describe.skipIf(!url)('database: request attachments', () => {
  const db = createDatabase(url ?? 'postgresql://unused');
  const repo = new PrismaAttachmentRepository(db);
  afterAll(async () => {
    await db.requestAttachment.deleteMany();
    await db.departmentRequest.deleteMany();
    await db.member.deleteMany();
    await db.department.deleteMany();
    await db.$disconnect();
  });

  it('stores metadata per request and side, counts, lists oldest first, and goes with its request (cascade)', async () => {
    await db.requestAttachment.deleteMany();
    await db.departmentRequest.deleteMany();
    await db.member.deleteMany();
    await db.department.deleteMany();
    const leader = await db.member.create({ data: { username: 'lead@x.com', fullName: 'Lead', role: 'ADMIN', passwordHash: 'x'.repeat(60) } });
    const dept = await db.department.create({ data: { name: 'Studio', leaderId: leader.id } });
    const sender = await db.member.create({ data: { username: 'a@x.com', fullName: 'A', passwordHash: 'x'.repeat(60) } });
    const req = await db.departmentRequest.create({ data: { fromMemberId: sender.id, toDepartmentId: dept.id, subject: 's', message: 'm' } });
    const base = { requestId: req.id, fileName: 'a.png', contentType: 'image/png', sizeBytes: 10, uploadedBy: 'a@x.com', uploadedByRole: 'member' as const };
    const one = await repo.create({ ...base, kind: 'REQUEST', storageKey: `${req.id}/one` });
    await repo.create({ ...base, kind: 'REQUEST', storageKey: `${req.id}/two` });
    await repo.create({ ...base, kind: 'REPLY', storageKey: `${req.id}/three`, uploadedBy: 'lead@x.com', uploadedByRole: 'admin' });

    expect(await repo.count(req.id, 'REQUEST')).toBe(2);
    expect(await repo.count(req.id, 'REPLY')).toBe(1);
    expect((await repo.listByRequestIds([req.id])).map((a) => a.storageKey)).toEqual([`${req.id}/one`, `${req.id}/two`, `${req.id}/three`]);
    await expect(repo.create({ ...base, kind: 'REQUEST', storageKey: `${req.id}/one` })).rejects.toThrow(); // storage keys are unique

    expect(await repo.remove(one.id)).toBe(true);
    expect(await repo.remove(one.id)).toBe(false);
    await db.departmentRequest.delete({ where: { id: req.id } });
    expect(await repo.listByRequestIds([req.id])).toEqual([]);
  });
});
