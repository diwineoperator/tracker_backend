-- Phase 1: department leaders (Admins) and cross-department requests.
--
-- Purely ADDITIVE. The single super admin still lives in the environment; a department
-- leader ("Admin") is an ordinary members row with role = 'ADMIN', so login, disabling,
-- passwords and department membership are all reused. Every existing member becomes
-- 'MEMBER' (the column default), so nothing about them changes.

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('MEMBER', 'ADMIN');
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'DECLINED');

-- AlterTable
ALTER TABLE "members" ADD COLUMN "role" "MemberRole" NOT NULL DEFAULT 'MEMBER';

-- At most ONE leader per department, enforced by the database itself. An admin must
-- belong to a department (they lead it), so a NULL department can never be an ADMIN.
CREATE UNIQUE INDEX "members_one_admin_per_department" ON "members" ("department_id") WHERE "role" = 'ADMIN';
ALTER TABLE "members" ADD CONSTRAINT "members_admin_has_department" CHECK ("role" <> 'ADMIN' OR "department_id" IS NOT NULL);

-- CreateTable
CREATE TABLE "department_requests" (
    "id" UUID NOT NULL,
    "from_member_id" UUID NOT NULL,
    "to_department_id" UUID NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "response" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "department_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "department_requests_subject_not_blank" CHECK (btrim("subject") <> ''),
    CONSTRAINT "department_requests_message_not_blank" CHECK (btrim("message") <> '')
);

-- CreateIndex
CREATE INDEX "department_requests_to_department_id_status_idx" ON "department_requests"("to_department_id", "status");
CREATE INDEX "department_requests_from_member_id_idx" ON "department_requests"("from_member_id");

-- A request only means something while both ends exist, so deleting the sender or the
-- receiving department removes it (their delete flows already warn about what goes with them).
ALTER TABLE "department_requests" ADD CONSTRAINT "department_requests_from_member_id_fkey" FOREIGN KEY ("from_member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_requests" ADD CONSTRAINT "department_requests_to_department_id_fkey" FOREIGN KEY ("to_department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
