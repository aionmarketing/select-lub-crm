/**
 * Test design (testing-strategy)
 *
 * Setup: useSelection zustand store, imported fresh (no DOM, no router).
 *
 * Oracle: no OpenSpec capability or Notion AC governs this store — it is pure
 * UI-selection state for the Conversas inbox (owned by another stream; out of
 * scope here). The oracle is the module's own JSDoc, authored before this
 * test (selectionStore.ts:6-9): "@returns `selectedConversationId` and
 * `select` to open or clear the active thread." That sentence documents two
 * outcomes of calling `select` — opening a thread (a truthy id) and clearing
 * it (`null`) — which this file cites rather than invents. Confirmed against
 * the implementation: `select: (id) => set({ selectedConversationId: id })`
 * agrees with the doc (code and doc do not diverge).
 *
 * Axes
 *   A1 initial state — never selected
 *   A2 select() argument — an id / null
 *
 * Outputs
 *   O1 selectedConversationId reflects the last select() call
 *
 * Sampled-cell
 *   starts unselected        | A1        | O1 | non-null default
 *   select opens a thread    | A2 id     | O1 | id not stored
 *   select(null) clears it   | A2 null   | O1 | prior id survives
 *
 * Decision map: `select` has no branch — it is one `set` call for either
 * argument. The two its below exist to pin BOTH outcomes the JSDoc names
 * ("open or clear"), not because the code branches.
 *
 * Out of scope: the Conversas inbox rendering that calls `select` on a click
 * (contact-rail.tsx / inbox.tsx — Session 7's files).
 */
import { describe, expect, it } from "vitest";
import { useSelection } from "./selectionStore.js";

describe("useSelection", () => {
  it("starts with no conversation selected", () => {
    expect(useSelection.getState().selectedConversationId).toBeNull();
  });

  it("select(id) opens that thread", () => {
    useSelection.getState().select("c1");
    expect(useSelection.getState().selectedConversationId).toBe("c1");
  });

  it("select(null) clears an open thread", () => {
    useSelection.getState().select("c1");
    useSelection.getState().select(null);
    expect(useSelection.getState().selectedConversationId).toBeNull();
  });
});
