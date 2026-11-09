-- CreateTable
CREATE TABLE "interval_rule" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "criterion" TEXT NOT NULL,
    "criterion_id" TEXT,
    "interval_amount" INTEGER NOT NULL,
    "interval_unit" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interval_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_message" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "conversation_id" TEXT,
    "service_id" TEXT,
    "template_id" TEXT,
    "frozen_text" TEXT NOT NULL,
    "suggested_at" TIMESTAMP(3),
    "suggestion_source" TEXT,
    "interval_rule_id" TEXT,
    "interval_rule_version" INTEGER,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "time_zone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "last_error" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "scheduled_message_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "outbox_message" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_message_idempotency_key_key" ON "scheduled_message"("idempotency_key");

-- CreateIndex
CREATE INDEX "scheduled_message_status_scheduled_at_idx" ON "scheduled_message"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_message_idempotency_key_key" ON "outbox_message"("idempotency_key");

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_interval_rule_id_fkey" FOREIGN KEY ("interval_rule_id") REFERENCES "interval_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
