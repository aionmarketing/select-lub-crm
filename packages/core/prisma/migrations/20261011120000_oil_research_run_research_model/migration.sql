-- switch-oil-research-to-openai D7 (owner, 2026-10-11): the research model a run was configured with,
-- `provider:model:effort` (for example `glm:glm-5.3-flash:high`), written at claim. The duration
-- estimate samples only the runs of the model in force, so GLM-era runs never set GPT-6.1 Sol's range;
-- a row written before this column (NULL) counts as glm:glm-5.3-flash:high, the only configuration
-- production ran. Additive only: one nullable column, no backfill; old code ignores it.

-- AlterTable
ALTER TABLE "oil_research_run" ADD COLUMN "research_model" TEXT;
