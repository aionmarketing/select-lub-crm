-- CreateTable
CREATE TABLE "tag" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "allowed_variables" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_tag" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "assigned_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tag_unit_id_idx" ON "tag"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_unit_id_name_active_key" ON "tag"("unit_id", "name") WHERE "active" = true;

-- CreateIndex
CREATE INDEX "template_unit_id_idx" ON "template"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_unit_id_name_active_key" ON "template"("unit_id", "name") WHERE "status" = 'active';

-- CreateIndex
CREATE INDEX "conversation_tag_conversation_id_idx" ON "conversation_tag"("conversation_id");

-- CreateIndex
CREATE INDEX "conversation_tag_tag_id_idx" ON "conversation_tag"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tag_open_apply_key" ON "conversation_tag"("conversation_id", "tag_id") WHERE "removed_at" IS NULL;

-- AddForeignKey
ALTER TABLE "tag" ADD CONSTRAINT "tag_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tag" ADD CONSTRAINT "conversation_tag_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tag" ADD CONSTRAINT "conversation_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
