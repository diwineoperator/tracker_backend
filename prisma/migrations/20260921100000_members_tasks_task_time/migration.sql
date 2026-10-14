-- Member → Task → Time tracking.
--
--   members            (new)  accounts the admin creates; the admin itself stays in .env
--   tasks              (new)  work assigned to exactly one member
--   activity_sessions  (kept) now records time spent ON A TASK BY A MEMBER;
--                             the free-text description is replaced by task_id
--
-- DESTRUCTIVE (confirmed): existing rows are the admin's old self-tracked entries
-- with no task or member, which the new model cannot represent, so they are
-- deleted. This keeps task_id / member_id strictly NOT NULL.

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "members_username_key" ON "members"("username");
CREATE INDEX "tasks_member_id_status_idx" ON "tasks"("member_id", "status");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── activity_sessions: from "admin's free-text activity" to "member's time on a task" ──

DELETE FROM "activity_sessions";

-- The old rules assumed a single global RUNNING row and a text description.
DROP INDEX "activity_sessions_single_running_idx";
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_description_not_blank_chk";
ALTER TABLE "activity_sessions" DROP COLUMN "description";

ALTER TABLE "activity_sessions"
    ADD COLUMN "task_id" UUID NOT NULL,
    ADD COLUMN "member_id" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "activity_sessions_member_id_started_at_idx" ON "activity_sessions"("member_id", "started_at" DESC);
CREATE INDEX "activity_sessions_task_id_idx" ON "activity_sessions"("task_id");

-- AddForeignKey
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written invariants (Prisma's schema language cannot express these).
-- The status/ended_at/duration CHECK from the init migration is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

-- Business rule: a member can never have more than one RUNNING activity.
-- (Different members may of course track time at the same moment.)
CREATE UNIQUE INDEX "activity_sessions_single_running_per_member_idx"
    ON "activity_sessions" ("member_id")
    WHERE "status" = 'RUNNING';

-- Usernames are stored lower-case so uniqueness is effectively case-insensitive.
ALTER TABLE "members"
    ADD CONSTRAINT "members_username_lowercase_chk" CHECK ("username" = lower("username")),
    ADD CONSTRAINT "members_username_not_blank_chk" CHECK (char_length(btrim("username")) > 0),
    ADD CONSTRAINT "members_full_name_not_blank_chk" CHECK (char_length(btrim("full_name")) > 0);

ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_title_not_blank_chk" CHECK (char_length(btrim("title")) > 0);
