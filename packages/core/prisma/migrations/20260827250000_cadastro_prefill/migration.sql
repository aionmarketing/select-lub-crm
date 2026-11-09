-- CreateTable
CREATE TABLE "cadastro_prefill_job" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadastro_prefill_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cadastro_prefill_suggestion" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "extracted_at" TIMESTAMP(3) NOT NULL,
    "job_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadastro_prefill_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadastro_prefill_job_conversation_id_status_idx" ON "cadastro_prefill_job"("conversation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cadastro_prefill_job_conversation_inflight_key" ON "cadastro_prefill_job"("conversation_id") WHERE status IN ('queued', 'running');

-- CreateIndex
CREATE UNIQUE INDEX "cadastro_prefill_suggestion_conversation_id_key" ON "cadastro_prefill_suggestion"("conversation_id");

-- AddForeignKey
ALTER TABLE "cadastro_prefill_job" ADD CONSTRAINT "cadastro_prefill_job_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadastro_prefill_suggestion" ADD CONSTRAINT "cadastro_prefill_suggestion_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadastro_prefill_suggestion" ADD CONSTRAINT "cadastro_prefill_suggestion_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "cadastro_prefill_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
