-- CreateTable
CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "text_body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "external_message_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_message_status_created_at_idx" ON "outbox_message"("status", "created_at");

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
