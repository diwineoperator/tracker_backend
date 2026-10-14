-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "activity_sessions" (
    "id" UUID NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "duration_seconds" INTEGER,
    "status" "ActivityStatus" NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "activity_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_sessions_started_at_idx" ON "activity_sessions"("started_at" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written invariants (Prisma's schema language cannot express these).
-- ─────────────────────────────────────────────────────────────────────────────

-- Business rule: the admin can never have more than one RUNNING activity.
-- A unique index over a constant expression, restricted to RUNNING rows, lets
-- at most one such row exist — even under concurrent requests.
-- When multi-user support arrives, replace `(1)` with the owner column, e.g.
--   CREATE UNIQUE INDEX ... ON "activity_sessions" ("user_id") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "activity_sessions_single_running_idx"
    ON "activity_sessions" ((1))
    WHERE "status" = 'RUNNING';

-- status, ended_at and duration_seconds must always agree with each other.
ALTER TABLE "activity_sessions"
    ADD CONSTRAINT "activity_sessions_state_consistency_chk" CHECK (
        ("status" = 'RUNNING'
            AND "ended_at" IS NULL
            AND "duration_seconds" IS NULL)
     OR ("status" = 'COMPLETED'
            AND "ended_at" IS NOT NULL
            AND "duration_seconds" IS NOT NULL
            AND "duration_seconds" >= 0
            AND "ended_at" >= "started_at")
     OR ("status" = 'CANCELLED'
            AND "ended_at" IS NOT NULL
            AND "duration_seconds" IS NULL)
    );

ALTER TABLE "activity_sessions"
    ADD CONSTRAINT "activity_sessions_description_not_blank_chk"
    CHECK (char_length(btrim("description")) > 0);
