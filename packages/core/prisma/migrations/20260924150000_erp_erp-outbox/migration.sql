-- erp_outbox: the writes the CRM owes the ERP (adopt-modular-vertical-slices
-- 3A.3). Owned by `erp` in ownership.json since wave 1; this creates it.
--
-- Sized to the only write-back that exists today: the sync engine's per-field
-- `put(erp_record_id, fields, integration_code)`, guarded by the field-sync
-- versions it was computed from. `versions` carries those versions so the
-- enqueuing module can mark the fields synced only if nothing moved while the
-- row waited. `customers` (4B) and `services` (3C) enqueue through erp's
-- `enqueue-write` contract; erp's `drain-outbox` pushes.
--
-- The CHECKs name only what exists: a customer or vehicle field put. A new
-- write-back (a service order, say) is a new `operation` and needs a migration,
-- which is the point.

-- CreateTable
CREATE TABLE "erp_outbox" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL DEFAULT 'put',
    "erp_record_id" TEXT NOT NULL,
    "integration_code" TEXT,
    "fields" JSONB NOT NULL,
    "versions" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "last_error" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erp_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "erp_outbox_entity_check" CHECK ("entity" IN ('customer', 'vehicle')),
    CONSTRAINT "erp_outbox_operation_check" CHECK ("operation" IN ('put')),
    CONSTRAINT "erp_outbox_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed'))
);

-- CreateIndex
CREATE UNIQUE INDEX "erp_outbox_idempotency_key_key" ON "erp_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "erp_outbox_status_next_attempt_at_idx" ON "erp_outbox"("status", "next_attempt_at");
