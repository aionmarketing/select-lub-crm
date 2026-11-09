-- CreateTable
CREATE TABLE "sync_execution" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "window_from" TIMESTAMP(3),
    "window_to" TIMESTAMP(3),
    "cursor" TEXT,
    "status" TEXT NOT NULL,
    "totals" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_error" (
    "id" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "correlation_id" TEXT,
    "code" TEXT,
    "message" TEXT,
    "retryable" BOOLEAN NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_error_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_execution_status_idx" ON "sync_execution"("status");

-- CreateIndex
CREATE INDEX "integration_error_integration_created_at_idx" ON "integration_error"("integration", "created_at");
