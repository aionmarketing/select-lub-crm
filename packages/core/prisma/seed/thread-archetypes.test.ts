/**
 * Test design (testing-strategy)
 *
 * Setup: pure. `assignThreadArchetypes` reads only its argument — no database,
 * no faker, no clock. Quote placement is checked by feeding the assignment's
 * outbound flag into `assignConversationRoles` (same sort).
 *
 * Oracle: demo-seed — "Seeded threads follow a workshop conversation mix":
 * one conversation per primary archetype when the batch can carry it; surplus
 * left unfilled rather than doubled; true-positive / vehicle traps need a
 * stored vehicle; a quote may not sit on a thread with no seeded outbound.
 *
 * Axes
 *   A1 batch size — 0 / fewer than primaries / more than primaries
 *   A2 stored vehicle — none / some / all
 *   A3 input order — sorted / shuffled
 *
 * Outputs
 *   O1 same batch twice → identical maps
 *   O2 short batch → unfilled primaries, unique conversation per filled archetype
 *   O3 quote role → conversation whose archetype has seeded outbound
 *   O4 leftover surplus cycles distinct leftover scripts
 *
 * Decision map of assignThreadArchetypes:
 *   D1 needsVehicle && !hasVehicle   true: skip candidate   false: eligible
 *   D2 unused conversation exists    true: fill             false: unfilled
 *   D3 leftover remains after primaries true: cycle leftovers  false: no leftover
 *   D4 batch length ≥ 2              true: clean id set     false: clean absent
 */
import { describe, expect, it } from "vitest";
import { assignConversationRoles } from "./plan.js";
import {
  assignThreadArchetypes,
  PRIMARY_THREAD_ARCHETYPES,
  threadHasSeededOutbound,
  type ThreadDecoratable,
} from "./thread-archetypes.js";

function conversation(
  id: string,
  options: { inbound?: string | null; hasVehicle?: boolean } = {},
): ThreadDecoratable {
  const inbound =
    options.inbound === undefined
      ? new Date(`2026-09-0${id.replace(/\D/g, "").slice(-1) || "1"}T12:00:00Z`)
      : options.inbound === null
        ? null
        : new Date(options.inbound);
  return {
    id,
    firstInboundAt: inbound,
    firstOutboundAt: null,
    hasVehicle: options.hasVehicle ?? true,
  };
}

function vehicleBatch(count: number): ThreadDecoratable[] {
  return Array.from({ length: count }, (_, i) =>
    conversation(`c${String(i + 1).padStart(2, "0")}`, {
      inbound: `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      hasVehicle: true,
    }),
  );
}

function assignmentSnapshot(batch: readonly ThreadDecoratable[]) {
  const { byConversation, unfilled, mistypedConversationId, cleanConversationId } =
    assignThreadArchetypes(batch);
  return {
    pairs: [...byConversation.entries()],
    unfilled: unfilled.map((row) => row.archetype),
    mistypedConversationId,
    cleanConversationId,
  };
}

function quoteOnSeededOutbound(batch: readonly ThreadDecoratable[]) {
  const assignment = assignThreadArchetypes(batch);
  const forRoles = batch.map((row) => {
    const archetype = assignment.byConversation.get(row.id);
    return {
      id: row.id,
      firstInboundAt: row.firstInboundAt,
      firstOutboundAt:
        archetype !== undefined && threadHasSeededOutbound(archetype)
          ? new Date("2026-09-01T13:00:00Z")
          : null,
    };
  });
  return {
    assignment,
    quoteConversationId: assignConversationRoles(forRoles).byRole.get("quote"),
  };
}

describe("assignThreadArchetypes", () => {
  it("fills every primary archetype once when the batch can carry them", () => {
    const { byConversation, unfilled } = assignThreadArchetypes(vehicleBatch(10));

    expect(unfilled).toEqual([]);
    for (const archetype of PRIMARY_THREAD_ARCHETYPES) {
      expect([...byConversation.values()]).toContain(archetype);
    }
    expect(byConversation.size).toBe(10);
    expect(new Set(byConversation.keys()).size).toBe(10);
  });

  it("gives the same assignment on a second call with the same batch", () => {
    const batch = vehicleBatch(10);

    expect(assignmentSnapshot(batch)).toEqual(assignmentSnapshot(batch));
  });

  it("ignores the order the batch arrives in", () => {
    const batch = vehicleBatch(8);

    expect(assignmentSnapshot([...batch].reverse())).toEqual(assignmentSnapshot(batch));
  });

  it("leaves surplus archetypes unfilled rather than doubling when the batch is short", () => {
    const { byConversation, unfilled } = assignThreadArchetypes(vehicleBatch(2));

    expect(byConversation.size).toBe(2);
    expect(new Set(byConversation.values()).size).toBe(2);
    expect(new Set(byConversation.keys()).size).toBe(2);
    expect(unfilled).toHaveLength(PRIMARY_THREAD_ARCHETYPES.length - 2);
    for (const entry of unfilled) {
      expect(entry.reason).not.toBe("");
    }
  });

  it("does not place two vehicle traps on the only conversation that has a vehicle", () => {
    const batch = [
      conversation("c1", { inbound: "2026-09-01T12:00:00Z", hasVehicle: false }),
      conversation("c2", { inbound: "2026-09-02T12:00:00Z", hasVehicle: true }),
      conversation("c3", { inbound: "2026-09-03T12:00:00Z", hasVehicle: false }),
    ];

    const { byConversation, unfilled } = assignThreadArchetypes(batch);

    expect(byConversation.get("c2")).toBe("truePositive");
    expect(unfilled.map((row) => row.archetype)).toEqual(
      expect.arrayContaining(["formerVehicle", "familyCar"]),
    );
    expect([...byConversation.values()].filter((row) => row === "truePositive")).toHaveLength(1);
  });

  it("puts the quote only on a conversation that will have seeded outbound", () => {
    const { assignment, quoteConversationId } = quoteOnSeededOutbound(vehicleBatch(8));

    expect(quoteConversationId).toEqual(expect.any(String));
    const archetype = assignment.byConversation.get(quoteConversationId!);
    expect(archetype).toBeDefined();
    expect(threadHasSeededOutbound(archetype!)).toBe(true);
    expect(archetype).not.toBe("bareHours");
  });

  it("leaves the quote unfilled when the only thread is inbound-only bare-hours", () => {
    const batch = [conversation("c1", { inbound: "2026-09-01T12:00:00Z", hasVehicle: false })];

    const { assignment, quoteConversationId } = quoteOnSeededOutbound(batch);

    expect(assignment.byConversation.get("c1")).toBe("bareHours");
    expect(quoteConversationId).toBeUndefined();
  });

  it("cycles leftover scripts instead of cloning one template", () => {
    const { byConversation, unfilled } = assignThreadArchetypes(vehicleBatch(11));

    expect(unfilled).toEqual([]);
    const leftovers = [...byConversation.values()].filter((row) => row.startsWith("leftover"));
    expect(leftovers).toEqual(["leftoverScheduling", "leftoverReturn", "leftoverPriceCheck"]);
  });

  it("fills nothing and reports every primary for an empty batch", () => {
    const { byConversation, unfilled } = assignThreadArchetypes([]);

    expect(byConversation.size).toBe(0);
    expect(unfilled).toHaveLength(PRIMARY_THREAD_ARCHETYPES.length);
    for (const entry of unfilled) {
      expect(entry.reason).toContain("no conversations");
    }
  });

  it("marks the last conversation mistyped and the first clean when the batch has two or more", () => {
    const batch = vehicleBatch(3);
    const { mistypedConversationId, cleanConversationId } = assignThreadArchetypes(batch);

    expect(cleanConversationId).toBe("c01");
    expect(mistypedConversationId).toBe("c03");
  });

  it("leaves the clean register unfilled on a single conversation", () => {
    const { mistypedConversationId, cleanConversationId } = assignThreadArchetypes(
      vehicleBatch(1),
    );

    expect(mistypedConversationId).toBe("c01");
    expect(cleanConversationId).toBeUndefined();
  });
});
