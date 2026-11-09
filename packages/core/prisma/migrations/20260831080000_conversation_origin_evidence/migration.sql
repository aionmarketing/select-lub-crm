-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "source_evidence_type" TEXT;
ALTER TABLE "conversation" ADD COLUMN "source_evidence_reference" TEXT;
ALTER TABLE "conversation" ADD COLUMN "source_evidence_at" TIMESTAMP(3);
ALTER TABLE "conversation" ADD COLUMN "ctwa_clid" TEXT;
ALTER TABLE "conversation" ADD COLUMN "campaign_id" TEXT;
ALTER TABLE "conversation" ADD COLUMN "ad_set_id" TEXT;
ALTER TABLE "conversation" ADD COLUMN "ad_id" TEXT;
ALTER TABLE "conversation" ADD COLUMN "classification_rule_version" TEXT;
