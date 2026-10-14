-- A request's ongoing conversation, after the original ask and the leader's first reply: either
-- side can keep adding messages from there.
CREATE TABLE "request_messages" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "author_role" VARCHAR(20) NOT NULL,
    "author_name" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "request_messages_request_id_idx" ON "request_messages"("request_id");

ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "department_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
