-- Replace task-assignment + live-timer tracking with the Daily Time Ledger.
--
-- The admin-assigns-task / member-starts-stops-a-timer model is retired entirely
-- in favour of a member logging retrospective time entries against a fixed
-- category, with the server computing the gap between consecutive entries.
--
-- DESTRUCTIVE (confirmed): "tasks" and "activity_sessions" are dropped along with
-- all their rows. The new model has no equivalent shape for them (no tasks, no
-- live timers), so there is nothing to migrate forward.

-- DropForeignKey
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_member_id_fkey";
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_task_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_member_id_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_member_id_fkey";

-- DropTable
DROP TABLE "activity_sessions";
DROP TABLE "tasks";

-- DropEnum
DROP TYPE "ActivityStatus";
DROP TYPE "TaskStatus";

-- CreateEnum
CREATE TYPE "TrackerCategory" AS ENUM ('WORK', 'SLEEP', 'HEALTH', 'PERSONAL', 'ENTERTAINMENT', 'LEARNING', 'OTHER', 'BASE');
CREATE TYPE "LedgerEntryType" AS ENUM ('TRACKER', 'GAP');

-- CreateTable
CREATE TABLE "time_tracker" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "category" "TrackerCategory" NOT NULL,
    "subcategory" VARCHAR(100),
    "comment" VARCHAR(500),
    "duration_minutes" INTEGER NOT NULL,
    "previous_tracker_time" TIMESTAMPTZ(3) NOT NULL,
    "tracker_time" TIMESTAMPTZ(3) NOT NULL,
    "gap_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_tracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_ledger" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "tracker_id" UUID,
    "date" DATE NOT NULL,
    "category" "TrackerCategory" NOT NULL,
    "subcategory" VARCHAR(100),
    "duration_minutes" INTEGER NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable — presence of a row = that member's local day is closed.
CREATE TABLE "daily_closure" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_closure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_tracker_member_id_date_idx" ON "time_tracker"("member_id", "date");
CREATE INDEX "time_ledger_member_id_date_idx" ON "time_ledger"("member_id", "date");
CREATE UNIQUE INDEX "daily_closure_member_id_date_key" ON "daily_closure"("member_id", "date");

-- AddForeignKey
ALTER TABLE "time_tracker" ADD CONSTRAINT "time_tracker_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "time_ledger" ADD CONSTRAINT "time_ledger_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "time_ledger" ADD CONSTRAINT "time_ledger_tracker_id_fkey"
    FOREIGN KEY ("tracker_id") REFERENCES "time_tracker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "daily_closure" ADD CONSTRAINT "daily_closure_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written invariants (Prisma's schema language cannot express these).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "time_tracker"
    ADD CONSTRAINT "time_tracker_duration_positive_chk" CHECK ("duration_minutes" > 0),
    ADD CONSTRAINT "time_tracker_gap_non_negative_chk" CHECK ("gap_minutes" >= 0);

ALTER TABLE "time_ledger"
    ADD CONSTRAINT "time_ledger_duration_positive_chk" CHECK ("duration_minutes" > 0);
