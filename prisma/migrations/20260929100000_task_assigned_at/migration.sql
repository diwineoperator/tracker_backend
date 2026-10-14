-- When a task reached its current member (set on creation and on reassignment). Existing tasks were assigned when
-- they were created.
ALTER TABLE "tasks" ADD COLUMN "assigned_at" TIMESTAMPTZ(3);
UPDATE "tasks" SET "assigned_at" = "created_at";
ALTER TABLE "tasks" ALTER COLUMN "assigned_at" SET NOT NULL, ALTER COLUMN "assigned_at" SET DEFAULT CURRENT_TIMESTAMP;
