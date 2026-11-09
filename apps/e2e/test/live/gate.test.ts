/**
 * Test design (testing-strategy)
 *
 * Setup: `evaluateLiveScheduleGate` with injected env/db/conversation. No Prisma,
 * no Evolution, no Playwright.
 *
 * Oracle: live-scheduled-messages repo-foundation — skip vs fail vs ready for
 *   Programar mensagem to 5519000000002.
 *
 * Axes
 *   A1 opt-in — unset / "1" / other
 *   A2 db — absent / local / remote+allow / remote / unparseable
 *   A3 conversation — missing (gate skip; resolve creates) / CONNECTED+right key / DISCONNECTED / forbidden key
 *
 * Outputs
 *   O1 skip; O2 fail (no writes); O3 ready
 *
 * Sampled-cell
 *   unset opt-in           | A1 unset            | O1 | run
 *   DATABASE_URL unset     | A1 1 A2 absent      | O1 | fail
 *   remote no override     | A1 1 A2 remote      | O2 | skip
 *   remote + override      | A1 1 A2 remote allow| O3 when conv | fail
 *   missing conversation   | A1 1 A2 local A3 miss | O1 | fail
 *   not CONNECTED          | A1 1 A3 DISCONNECTED | O2 | skip
 *   forbidden chatKey      | A1 1 A3 5519000000001 | O2 | ready
 *   ready dest             | A1 1 A3 CONNECTED   | O3 | skip
 *
 * Decision map (gate.ts)
 *   optIn !== "1"                 T skip; F db its
 *   db absent                     T skip; F remote/unparseable/local
 *   db unparseable                T fail; F remote its
 *   remote && !allowRemote        T fail; F conversation its
 *   conversation null             T skip; F forbidden / chatKey / CONNECTED
 *   chatKey forbidden             T fail; F expected key
 *   chatKey !== LIVE              T fail; F CONNECTED
 *   connectionState !== CONNECTED T fail; F ready
 *
 * Out of scope: Prisma lookup (resolve.ts); Playwright UI.
 */
import { describe, expect, it } from "vitest";
import { evaluateLiveScheduleGate } from "./gate.js";
import { FORBIDDEN_SCHEDULE_CHAT_KEY, LIVE_SCHEDULE_CHAT_KEY } from "./ids.js";

const readyConv = {
  id: "conv-live",
  chatKey: LIVE_SCHEDULE_CHAT_KEY,
  customerId: "cus-live",
  unitId: "unit-a",
  connectionState: "CONNECTED",
};

describe("evaluateLiveScheduleGate", () => {
  it("skips when opt-in is unset", () => {
    const result = evaluateLiveScheduleGate({
      optIn: undefined,
      db: { kind: "local" },
      conversation: readyConv,
    });
    expect(result).toEqual({ kind: "skip", reason: "E2E_LIVE_SCHEDULE is not 1" });
  });

  it("skips when DATABASE_URL is unset even if opted in", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "absent" },
      conversation: readyConv,
    });
    expect(result.kind).toBe("skip");
  });

  it("fails a remote host without LIVE_TESTS_ALLOW_REMOTE and names it", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "remote", host: "db.abcdefgh.supabase.co", allowRemote: false },
      conversation: readyConv,
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.message).toContain("db.abcdefgh.supabase.co");
    }
  });

  it("skips when the designated conversation is missing", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "local" },
      conversation: null,
    });
    expect(result).toEqual({
      kind: "skip",
      reason: `no conversation with chatKey ${LIVE_SCHEDULE_CHAT_KEY}`,
    });
  });

  it("fails when the instance is not CONNECTED", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "local" },
      conversation: { ...readyConv, connectionState: "DISCONNECTED" },
    });
    expect(result.kind).toBe("fail");
  });

  it("fails when the conversation is the forbidden dest", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "local" },
      conversation: { ...readyConv, chatKey: FORBIDDEN_SCHEDULE_CHAT_KEY },
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.message).toContain(FORBIDDEN_SCHEDULE_CHAT_KEY);
    }
  });

  it("is ready for CONNECTED 5519000000002 on a local database", () => {
    const result = evaluateLiveScheduleGate({
      optIn: "1",
      db: { kind: "local" },
      conversation: readyConv,
    });
    expect(result).toEqual({ kind: "ready", conversation: readyConv });
  });
});

describe("resolveLiveScheduleContext", () => {
  it("skips without Prisma when E2E_LIVE_SCHEDULE is unset", async () => {
    const { resolveLiveScheduleContext } = await import("./resolve.js");
    const result = await resolveLiveScheduleContext({
      ...process.env,
      E2E_LIVE_SCHEDULE: undefined,
    });
    expect(result.kind).toBe("skip");
  });
});
