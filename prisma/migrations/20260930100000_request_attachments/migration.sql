-- Files attached to a request (by the member) or to its reply (by the leader / super admin).
-- Only metadata is stored here; the bytes live in the file store under "storage_key".
CREATE TYPE "AttachmentKind" AS ENUM ('REQUEST', 'REPLY');

CREATE TABLE "request_attachments" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(150) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(120) NOT NULL,
    "uploaded_by" VARCHAR(100) NOT NULL,
    "uploaded_by_role" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "request_attachments_storage_key_key" ON "request_attachments"("storage_key");
CREATE INDEX "request_attachments_request_id_idx" ON "request_attachments"("request_id");

ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "department_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
