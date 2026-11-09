/**
 * Test design (testing-strategy)
 *
 * Setup: pure. `assignConversationRoles` reads only its argument — no database,
 * no faker, no clock. The whole point of extracting it from the seed.
 *
 * Oracle: demo-seed — a demo role hangs off exactly one conversation; a quote may
 * not sit on a conversation recording no outbound message ("Seeded conversations
 * never contradict their own activity"); an unfillable role is skipped and
 * reported rather than forced or fatal (design.md, settled 2026-09-07).
 *
 * Axes
 *   A1 batch size — 0 / fewer than roles / more than roles
 *   A2 outbound present — none / some / all
 *   A3 input order — sorted / shuffled
 *   A4 inbound timestamp — present / null (sorts last)
 *
 * Decision map of assignConversationRoles:
 *   D1 conversationCanCarry("quote")  true: quote filled   false: quote unfilled
 *   D2 an unused conversation exists  true: role filled    false: role unfilled
 *   D3 sort comparator equal times    true: id tie-break   false: time order
 *   Both arms of D1 and D2 are sampled. A suite asserting only the unfilled arm
 *   passes against an implementation that fills nothing, which is the failure
 *   this file is shaped to catch.
 *
 * What would make a test fail:
 *   Assigning one conversation two roles, which would make two demo surfaces
 *   point at the same thread. Placing the quote on a conversation with no reply,
 *   the contradiction the spec forbids. Letting input order change the result,
 *   which would make the seed non-reproducible. Reporting a role as unfilled
 *   without saying why, leaving an operator to guess whether it is a bug.
 */
import { describe, expect, it } from "vitest";
import { assignConversationRoles, type DecoratableConversation } from "./plan.js";

const ROLE_COUNT = 4;

function conversation(
  id: string,
  options: { inbound?: string | null; outbound?: string | null } = {},
): DecoratableConversation {
  return {
    id,
    firstInboundAt: options.inbound === undefined ? new Date(`2026-09-0${id.slice(-1)}T12:00:00Z`) : options.inbound === null ? null : new Date(options.inbound),
    firstOutboundAt: options.outbound === undefined || options.outbound === null ? null : new Date(options.outbound),
  };
}

/** A batch big enough for every role, all of them answered. */
function answeredBatch(): DecoratableConversation[] {
  return Array.from({ length: 6 }, (_, i) =>
    conversation(`c${i + 1}`, {
      inbound: `2026-09-0${i + 1}T12:00:00Z`,
      outbound: `2026-09-0${i + 1}T13:00:00Z`,
    }),
  );
}

describe("assignConversationRoles", () => {
  it("fills every role when the batch can carry them, one conversation each", () => {
    // The positive arm of D1 and D2. Without it, every "unfilled" assertion
    // below would also pass against an implementation that never fills anything.
    const { byRole, unfilled } = assignConversationRoles(answeredBatch());

    expect(unfilled).toEqual([]);
    expect(byRole.size).toBe(ROLE_COUNT);
    expect(new Set(byRole.values()).size).toBe(ROLE_COUNT);
  });

  it("gives the same assignment on a second call with the same batch", () => {
    const first = assignConversationRoles(answeredBatch());
    const second = assignConversationRoles(answeredBatch());

    expect([...second.byRole]).toEqual([...first.byRole]);
  });

  it("ignores the order the batch arrives in", () => {
    // Sorting is what makes the seed reproducible; without it the assignment
    // would follow whatever order the database happened to return.
    const sorted = assignConversationRoles(answeredBatch());
    const shuffled = assignConversationRoles([...answeredBatch()].reverse());

    expect([...shuffled.byRole]).toEqual([...sorted.byRole]);
  });

  it("leaves the quote unfilled, and says why, when nothing was ever replied to", () => {
    const batch = Array.from({ length: 6 }, (_, i) =>
      conversation(`c${i + 1}`, { inbound: `2026-09-0${i + 1}T12:00:00Z`, outbound: null }),
    );

    const { byRole, unfilled } = assignConversationRoles(batch);

    expect(byRole.has("quote")).toBe(false);
    expect(unfilled.map((entry) => entry.role)).toEqual(["quote"]);
    expect(unfilled[0]?.reason).toContain("outbound");
    // The other four still get placed: one unfillable role must not sink the rest.
    expect(byRole.size).toBe(ROLE_COUNT - 1);
  });

  it("puts the quote on a conversation that really was replied to, not merely any", () => {
    // c3 is the only answered one, and it is not first in sort order, so an
    // implementation that ignored the constraint and took the earliest would fail.
    const batch = [
      conversation("c1", { inbound: "2026-09-01T12:00:00Z", outbound: null }),
      conversation("c2", { inbound: "2026-09-02T12:00:00Z", outbound: null }),
      conversation("c3", { inbound: "2026-09-03T12:00:00Z", outbound: "2026-09-03T13:00:00Z" }),
    ];

    expect(assignConversationRoles(batch).byRole.get("quote")).toBe("c3");
  });

  it("leaves surplus roles unfilled rather than doubling up when the batch is short", () => {
    const { byRole, unfilled } = assignConversationRoles(answeredBatch().slice(0, 2));

    expect(byRole.size).toBe(2);
    expect(new Set(byRole.values()).size).toBe(2);
    expect(unfilled).toHaveLength(ROLE_COUNT - 2);
    for (const entry of unfilled) {
      expect(entry.reason).not.toBe("");
    }
  });

  it("fills nothing and reports every role for an empty batch", () => {
    const { byRole, unfilled } = assignConversationRoles([]);

    expect(byRole.size).toBe(0);
    expect(unfilled).toHaveLength(ROLE_COUNT);
    // Every reason must blame the absence of conversations, including the
    // quote's. Telling an operator "no conversation has an outbound message"
    // when the database holds none at all sends them to look at reply activity
    // instead of at whether any traffic ever arrived.
    for (const entry of unfilled) {
      expect(entry.reason).toContain("no conversations");
      expect(entry.reason).not.toContain("outbound");
    }
  });

  it("sorts conversations with no inbound timestamp last, breaking ties on id", () => {
    // A3/A4. Two share a timestamp so the id tie-break is exercised, and the
    // null-inbound row must not win the first role by arriving first.
    const batch = [
      conversation("zzz", { inbound: null, outbound: "2026-09-01T13:00:00Z" }),
      conversation("bbb", { inbound: "2026-09-01T12:00:00Z", outbound: "2026-09-01T13:00:00Z" }),
      conversation("aaa", { inbound: "2026-09-01T12:00:00Z", outbound: "2026-09-01T13:00:00Z" }),
    ];

    const { byRole } = assignConversationRoles(batch);

    expect(byRole.get("quote")).toBe("aaa");
    expect(byRole.get("prefillFailed")).toBe("bbb");
    expect(byRole.get("prefillPending")).toBe("zzz");
  });
});
