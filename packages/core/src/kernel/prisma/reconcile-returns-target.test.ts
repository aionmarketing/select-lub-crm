/**
 * Test design (testing-strategy)
 *
 * SUT: `resolveReconcileReturnsTarget`, the guard `pnpm db:reconcile-returns`
 *   runs before it connects. Pure; no database.
 *
 * Oracle: owner rulings 2026-09-25, PR 3 — the script must be pointed at a
 *   database explicitly (it reads no `.env`), says which host it writes to on
 *   every run, and, unlike `db:seed`, may run on a remote host: production is
 *   what it is for. The host is read by the shared resolveDatabaseTarget.
 *
 * Cases: unset, blank and unreadable are refused, naming the fix; a local and a
 *   remote URL are allowed with a `writing to <host>` line; a password holding
 *   `@` still yields the real host (the parser, not a split).
 */
import { describe, expect, it } from "vitest";
import { resolveReconcileReturnsTarget } from "./reconcile-returns-target.js";

describe("resolveReconcileReturnsTarget", () => {
  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["unreadable", "not a url"],
  ])("refuses a DATABASE_URL that is %s, and says how to set one", (_label, value) => {
    const decision = resolveReconcileReturnsTarget({ DATABASE_URL: value });

    expect(decision.kind).toBe("refused");
    expect(decision.message).toContain("reconcile-returns: refusing to run");
    expect(decision.message).toContain('DATABASE_URL="<production DIRECT_URL>" pnpm db:reconcile-returns');
  });

  it("allows a local database and names its host", () => {
    const decision = resolveReconcileReturnsTarget({
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/selectlub",
    });

    expect(decision).toEqual({
      kind: "allowed",
      url: "postgresql://u:p@127.0.0.1:5433/selectlub",
      message: "reconcile-returns: writing to 127.0.0.1",
    });
  });

  it("allows a remote database, which is what it is for, and names the real host", () => {
    // The password holds an `@`: a guard splitting on it would name the wrong host.
    const url = "postgresql://postgres:p%40ss@word@db.example.supabase.co:5432/postgres";
    const decision = resolveReconcileReturnsTarget({ DATABASE_URL: url });

    expect(decision.kind).toBe("allowed");
    expect(decision.message).toBe("reconcile-returns: writing to db.example.supabase.co");
  });
});
