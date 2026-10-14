-- Adds an updated_at to time_tracker, needed now that entries can be edited
-- (admin: any entry; member: their own, while the day is still OPEN).
-- Existing rows backfill to their own created_at (a real, if approximate, value —
-- they've never actually been edited).

-- AlterTable
ALTER TABLE "time_tracker" ADD COLUMN "updated_at" TIMESTAMPTZ(3);
UPDATE "time_tracker" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "time_tracker" ALTER COLUMN "updated_at" SET NOT NULL;
