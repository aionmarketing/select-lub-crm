/**
 * Test design (testing-strategy)
 *
 * Setup: pure. `planWorkshopSeedBatch` after `planDemoCustomers` (faker reset).
 *
 * Oracle: two equal conversation sets → identical SEED bodies; leftover surplus
 * uses more than one script; no LLM (fetch spy).
 *
 * Axes: A1 two full plans after reset; A2 surplus leftovers
 */
import { describe, expect, it, vi } from "vitest";
import { planDemoCustomers } from "./plan.js";
import { planWorkshopSeedBatch, type WorkshopConversation } from "./workshop-threads.js";

function batch(count: number): WorkshopConversation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${String(i + 1).padStart(2, "0")}`,
    chatKey: `5519${String(900000000 + i)}`,
    firstInboundAt: new Date(`2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`),
    firstOutboundAt: null,
    startedAt: new Date(`2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`),
    hasVehicle: true,
  }));
}

function planOnce(count: number) {
  const conversations = batch(count);
  const customers = planDemoCustomers(count);
  const customerByConversationId = new Map(
    conversations.map((row, index) => [row.id, customers[index]!]),
  );
  const customerIndexByConversationId = new Map(
    conversations.map((row, index) => [row.id, index]),
  );
  return planWorkshopSeedBatch({
    conversations,
    customerByConversationId,
    customerIndexByConversationId,
  });
}

describe("planWorkshopSeedBatch", () => {
  it("produces identical SEED bodies on two plans of the same conversations", () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;

    const first = planOnce(11);
    const second = planOnce(11);

    const bodies = (planned: typeof first) =>
      [...planned.plannedByConversation.entries()].map(([id, rows]) => [
        id,
        rows.map((row) => row.textBody),
      ]);
    expect(bodies(second)).toEqual(bodies(first));
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
  });

  it("cycles leftover scripts on surplus conversations", () => {
    const planned = planOnce(11);
    const leftovers = [...planned.assignment.byConversation.values()].filter((row) =>
      row.startsWith("leftover"),
    );

    expect(new Set(leftovers).size).toBeGreaterThanOrEqual(2);
  });
});
