-- CreateTable
CREATE TABLE "attribution_rule" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "window_days" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribution_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_scheduled_attribution" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "scheduled_message_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_scheduled_attribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_conversation_attribution" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_conversation_attribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attribution_rule_version_key" ON "attribution_rule"("version");

-- CreateIndex
CREATE UNIQUE INDEX "service_scheduled_attribution_service_id_scheduled_message_id_key" ON "service_scheduled_attribution"("service_id", "scheduled_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_conversation_attribution_service_id_conversation_id_key" ON "service_conversation_attribution"("service_id", "conversation_id");

-- AddForeignKey
ALTER TABLE "service_scheduled_attribution" ADD CONSTRAINT "service_scheduled_attribution_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_scheduled_attribution" ADD CONSTRAINT "service_scheduled_attribution_scheduled_message_id_fkey" FOREIGN KEY ("scheduled_message_id") REFERENCES "scheduled_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_conversation_attribution" ADD CONSTRAINT "service_conversation_attribution_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_conversation_attribution" ADD CONSTRAINT "service_conversation_attribution_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Initial 30-day global rule (version 1). Editing the window inserts a new version; this row stays 30.
INSERT INTO "attribution_rule" ("id", "version", "window_days", "created_at", "updated_at")
VALUES ('attribution-rule-v1', 1, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
