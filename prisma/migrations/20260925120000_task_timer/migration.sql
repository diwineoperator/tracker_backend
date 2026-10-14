-- A member's optional running stopwatch on a task: just the instant it was started.
-- Purely ADDITIVE and NULLABLE. It never feeds the ledger, gap, used/remaining or
-- day-closing maths — when the member stops, the elapsed minutes only PRE-FILL the
-- normal Add Tracker form, and the entry is saved through the existing code path.
ALTER TABLE "tasks" ADD COLUMN "timer_started_at" TIMESTAMPTZ(3);

-- At most ONE running stopwatch per member, enforced by the database itself so two
-- simultaneous "Start" taps can't both win.
CREATE UNIQUE INDEX "tasks_one_running_timer_per_member" ON "tasks" ("assigned_member_id") WHERE "timer_started_at" IS NOT NULL;
