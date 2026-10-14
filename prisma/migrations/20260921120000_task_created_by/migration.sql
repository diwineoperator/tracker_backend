-- Tasks record who created them ("Created By"), in addition to who they are
-- assigned to ("Assigned To" = tasks.member_id).
--
-- NULL means "created by the Admin": the admin lives in the environment, not in
-- `members`, so it has no row to point at. Every task that existed before this
-- migration was created by the admin, so leaving the column NULL is correct and
-- no existing data is touched.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "created_by_member_id" UUID;

-- AddForeignKey
-- RESTRICT: a creator can never silently become "Admin" by their row disappearing.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_member_id_fkey"
    FOREIGN KEY ("created_by_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
