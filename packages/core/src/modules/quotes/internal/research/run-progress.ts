/**
 * A run row's progress (background-oil-research D3, D14): the meter's snapshot and the per-stage
 * milliseconds, flushed by every compare-and-set write after a claim.
 */
import { Prisma, type DbClient } from "@select-lub/core/db";
import type { MeterSnapshot } from "../model-calls/meter.js";

/** What a run has measured so far: the meter's snapshot and the per-stage milliseconds. */
export type RunProgress = { meter?: MeterSnapshot; stageMs?: Record<string, number> };

export function progressData(progress: RunProgress): Prisma.OilResearchRunUpdateManyMutationInput {
  const data: Prisma.OilResearchRunUpdateManyMutationInput = {};
  if (progress.stageMs) data.stageMs = progress.stageMs;
  const meter = progress.meter;
  if (meter) {
    data.glmCalls = meter.modelCalls;
    data.searchCalls = meter.searchCalls;
    data.timedOutCalls = meter.timedOutCalls;
    data.tokens = meter.models as unknown as Prisma.InputJsonValue;
    data.usageKnown = meter.usageKnown;
    data.costUsd = new Prisma.Decimal(meter.costUsd.toFixed(6));
    data.efforts = meter.efforts as unknown as Prisma.InputJsonValue;
    data.pickerCalls = meter.picker.calls;
    data.pickerTokens = meter.picker.usage as unknown as Prisma.InputJsonValue;
    data.pickerCostUsd = new Prisma.Decimal(meter.picker.costUsd.toFixed(6));
  }
  return data;
}

export async function writeRun(tx: DbClient, runId: string, data: Prisma.OilResearchRunUpdateManyMutationInput): Promise<void> {
  if (Object.keys(data).length > 0) await tx.oilResearchRun.updateMany({ where: { id: runId }, data });
}
