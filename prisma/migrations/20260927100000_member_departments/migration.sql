-- Members may belong to up to TWO departments, so "which department" can no longer be a
-- single column on members. It becomes a proper relationship:
--
--   member_departments (member_id, department_id)   — a MEMBER's memberships (1..2)
--   departments.leader_id (UNIQUE, nullable)         — the Admin who leads a department
--
-- A leader (role ADMIN) is not a member of the department; they lead exactly one, and each
-- department has at most one leader — both guaranteed by the UNIQUE on leader_id.
--
-- Existing data is carried over first (every member's department becomes a membership, every
-- leader becomes its department's leader_id), and only then is members.department_id dropped.

-- 1. The relationship table ---------------------------------------------------------------
CREATE TABLE "member_departments" (
    "member_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_departments_pkey" PRIMARY KEY ("member_id", "department_id")
);

CREATE INDEX "member_departments_department_id_idx" ON "member_departments"("department_id");

-- A membership only means something while both ends exist.
ALTER TABLE "member_departments" ADD CONSTRAINT "member_departments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_departments" ADD CONSTRAINT "member_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most 2 departments per member, enforced by the database itself (the API checks first).
CREATE FUNCTION "member_departments_limit"() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "member_departments" WHERE "member_id" = NEW."member_id") >= 2 THEN
    RAISE EXCEPTION 'A member can belong to at most 2 departments' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "member_departments_limit_trg" BEFORE INSERT ON "member_departments" FOR EACH ROW EXECUTE FUNCTION "member_departments_limit"();

-- 2. The leader ----------------------------------------------------------------------------
ALTER TABLE "departments" ADD COLUMN "leader_id" UUID;
CREATE UNIQUE INDEX "departments_leader_id_key" ON "departments"("leader_id");
-- Deleting a leader account leaves the department leaderless (it can be given a new one).
ALTER TABLE "departments" ADD CONSTRAINT "departments_leader_id_fkey" FOREIGN KEY ("leader_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Carry the existing data over ---------------------------------------------------------
INSERT INTO "member_departments" ("member_id", "department_id")
SELECT "id", "department_id" FROM "members" WHERE "department_id" IS NOT NULL AND "role" = 'MEMBER';

UPDATE "departments" d SET "leader_id" = m."id" FROM "members" m WHERE m."role" = 'ADMIN' AND m."department_id" = d."id";

-- 4. Retire the single-department column (and what depended on it) -------------------------
ALTER TABLE "members" DROP CONSTRAINT "members_admin_has_department";
DROP INDEX "members_one_admin_per_department";
ALTER TABLE "members" DROP CONSTRAINT "members_department_id_fkey";
ALTER TABLE "members" DROP COLUMN "department_id";
