-- CreateTable
CREATE TABLE "plate_lookup" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fields" JSONB,
    "raw_payload" JSONB,
    "looked_up_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plate_lookup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_lookup_call" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "unit_id" TEXT,
    "billed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plate_lookup_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plate_lookup_plate_key" ON "plate_lookup"("plate");

-- CreateIndex
CREATE INDEX "plate_lookup_call_plate_idx" ON "plate_lookup_call"("plate");
