-- Departments, member→department, and admin-assigned tasks (with an optional
-- link from a Time Tracker entry to the task it was logged against).
--
-- Purely ADDITIVE: no existing column, row, or constraint is changed.
--   * members.department_id is NULLABLE — members created before departments
--     existed simply have none until an admin assigns one.
--   * time_tracker.task_id is NULLABLE — an entry without a task behaves exactly
--     as before; the ledger/gap/used/remaining maths never reads it.
-- Every new foreign key is ON DELETE RESTRICT: a department or task that is still
-- referenced can't be deleted out from under its members / time entries.

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "departments_name_not_blank_chk" CHECK (btrim("name") <> '')
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "department_id" UUID NOT NULL,
    "assigned_member_id" UUID NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "due_date" DATE,
    "created_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tasks_title_not_blank_chk" CHECK (btrim("title") <> '')
);

-- AlterTable
ALTER TABLE "members" ADD COLUMN "department_id" UUID;
ALTER TABLE "time_tracker" ADD COLUMN "task_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");
CREATE INDEX "tasks_assigned_member_id_status_idx" ON "tasks"("assigned_member_id", "status");
CREATE INDEX "tasks_department_id_idx" ON "tasks"("department_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_member_id_fkey"
    FOREIGN KEY ("assigned_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "members" ADD CONSTRAINT "members_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "time_tracker" ADD CONSTRAINT "time_tracker_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
