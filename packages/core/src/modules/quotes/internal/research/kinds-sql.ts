/**
 * SQL fragments for a research kind's strength (background-oil-research D7): `refetch` >
 * `engine_pick` > `full` > `manual_resolve`. Shared by the enqueue and the writes that merge a pending cycle.
 */
import { Prisma } from "@select-lub/core/db";

export const sql = Prisma.sql;

/** A kind's strength: refetch 4 > engine_pick 3 > full 2 > manual_resolve 1 (D7, D24). */
export function strength(kind: Prisma.Sql): Prisma.Sql {
  return sql`(CASE ${kind} WHEN 'refetch' THEN 4 WHEN 'engine_pick' THEN 3 WHEN 'full' THEN 2 WHEN 'manual_resolve' THEN 1 ELSE 0 END)`;
}

/**
 * The `SET` assignments that clear an engine pick's copy when `newCycle` holds (orchestrator,
 * 2026-10-01): a cycle of another kind never carries the engine, its origin, its passages or its
 * reopened flag. The enqueue writes them itself, for the cycle it starts.
 */
export function clearEnginePickWhen(newCycle: Prisma.Sql): Prisma.Sql {
  return sql`engine_pick_engine = CASE WHEN ${newCycle} THEN NULL ELSE engine_pick_engine END,
      engine_pick_from = CASE WHEN ${newCycle} THEN NULL ELSE engine_pick_from END,
      engine_pick_passages = CASE WHEN ${newCycle} THEN NULL ELSE engine_pick_passages END,
      engine_pick_reopened = CASE WHEN ${newCycle} THEN false ELSE engine_pick_reopened END,`;
}

/** The stronger of two kinds, `a` on a tie. */
export function stronger(a: Prisma.Sql, b: Prisma.Sql): Prisma.Sql {
  return sql`(CASE WHEN ${strength(b)} > ${strength(a)} THEN ${b} ELSE ${a} END)`;
}
