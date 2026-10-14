-- When a task was marked Done. Purely ADDITIVE and NULLABLE: no existing column or
-- row changes meaning. Tasks that were already Done get their last-updated time as
-- the best available completion time; every other task stays NULL.
ALTER TABLE "tasks" ADD COLUMN "completed_at" TIMESTAMPTZ(3);

UPDATE "tasks" SET "completed_at" = "updated_at" WHERE "status" = 'DONE';
