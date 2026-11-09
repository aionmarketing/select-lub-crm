/**
 * Test design (testing-strategy)
 *
 * Setup: call resolveDatabaseTarget with an explicit env object. Never reads
 * process.env, so these cases are the same on a developer machine, in CI, and
 * with or without a .env present — and none of them needs a database.
 *
 * Spec rule (isolate-and-guard-database-targets):
 *   Classify DATABASE_URL as absent / unparseable / local / remote. Fail
 *   closed: an unset, blank, malformed or host-less value must never come back
 *   as local. The host must be read with a URL parser, because a password may
 *   itself contain "@".
 *
 * Partitions (one numbered group = inputs the spec treats the same):
 *
 *   P1 ABSENT      — DATABASE_URL undefined, or blank/whitespace
 *   P2 UNPARSEABLE — set but not a URL, or a URL with no host
 *   P3 LOCAL       — host is one of LOOPBACK_HOSTS, including bracketed IPv6
 *                    and a differently-cased spelling
 *   P4 REMOTE      — any other host, including one reached past an "@" in the
 *                    password (the shape the production URL actually has)
 *
 * Output partitions:
 *   O1 — kind === "absent" (P1)
 *   O2 — kind === "unparseable" (P2)
 *   O3 — kind === "local", host stripped of IPv6 brackets (P3)
 *   O4 — kind === "remote", host is the real host not part of the password (P4)
 *
 * Limits: the loopback boundary itself. 127.0.0.1 is local; 127.0.0.2 is not
 * asserted either way because the spec names an explicit host list rather than
 * a range, so a range check would be testing an implementation we did not
 * specify.
 *
 * Map from each `it` to a partition:
 *
 *   absent when DATABASE_URL is unset / blank            — P1 -> O1
 *   unparseable when not a URL / has no host             — P2 -> O2
 *   local for each loopback host / bracketed IPv6 / case — P3 -> O3
 *   remote for a hosted database                         — P4 -> O4
 *   remote when the password contains "@"                — P4 -> O4
 *
 * describeDatabaseTarget has one switch, and each of its four labels is taken:
 * absent and unparseable by the explanation case, remote and local by the two
 * host cases. The "local" label is not decoration — the seed prints this line
 * on every run, and the local run is the common one.
 *
 * What would make a test fail:
 *   Splitting the URL on "@" instead of parsing it (the password case would
 *   report a fragment of the password as the host, and could classify a hosted
 *   database as local). Treating an unparseable value as usable. Returning a
 *   bare boolean, which would collapse P1 and P4 — the seed and the live-test
 *   gate need those two kept apart.
 */
import { describe, expect, it } from "vitest";
import { LOOPBACK_HOSTS, describeDatabaseTarget, resolveDatabaseTarget } from "./database-target.js";

describe("resolveDatabaseTarget", () => {
  it("reports absent when DATABASE_URL is unset", () => {
    expect(resolveDatabaseTarget({})).toEqual({ kind: "absent" });
    expect(resolveDatabaseTarget({ DATABASE_URL: undefined })).toEqual({ kind: "absent" });
  });

  it("reports absent when DATABASE_URL is blank", () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: "" })).toEqual({ kind: "absent" });
    expect(resolveDatabaseTarget({ DATABASE_URL: "   " })).toEqual({ kind: "absent" });
  });

  it.each([
    ["not a url", "not a url"],
    ["a scheme with no host", "postgresql:///only-a-path"],
  ])("reports unparseable for %s", (_label, value) => {
    expect(resolveDatabaseTarget({ DATABASE_URL: value }).kind).toBe("unparseable");
  });

  it.each(LOOPBACK_HOSTS.filter((h) => h !== "::1"))("reports local for %s", (host) => {
    expect(resolveDatabaseTarget({ DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).toEqual({
      kind: "local",
      host,
      database: "db",
    });
  });

  it("reports local for bracketed IPv6 loopback, with the brackets stripped", () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: "postgresql://u:p@[::1]:5432/db" })).toEqual({
      kind: "local",
      host: "::1",
      database: "db",
    });
  });

  it.each([
    ["a named database", "postgresql://u:p@127.0.0.1:5433/selectlub_realbase", "selectlub_realbase"],
    ["no database at all", "postgresql://u:p@127.0.0.1:5433", ""],
    ["a bare trailing slash", "postgresql://u:p@127.0.0.1:5433/", ""],
  ])("reads the database name from %s", (_label, url, expected) => {
    // Host does not identify a database: every worktree database and the
    // pristine base share 127.0.0.1:5433, so the seed guard keys on this field.
    // The two empty cases must be "" rather than a name, or a guard comparing
    // against a constant could match by accident.
    expect(resolveDatabaseTarget({ DATABASE_URL: url })).toMatchObject({ database: expected });
  });

  it("reports local regardless of host casing", () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: "postgresql://u:p@LOCALHOST:5432/db" }).kind).toBe(
      "local",
    );
  });

  it("reports remote for a hosted database", () => {
    expect(
      resolveDatabaseTarget({
        DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
      }),
    ).toEqual({ kind: "remote", host: "db.example.supabase.co", database: "postgres" });
  });

  it("reports remote when the password itself contains @", () => {
    // Splitting on "@" would read "ss" or "w0rd" as the host and could then
    // classify a hosted database as local. This is the shape the real
    // production URL has, which is why it is asserted rather than assumed.
    expect(
      resolveDatabaseTarget({
        DATABASE_URL: "postgresql://postgres:p@ss@w0rd@db.example.supabase.co:5432/postgres",
      }),
    ).toEqual({ kind: "remote", host: "db.example.supabase.co", database: "postgres" });
  });

  it("never reports local for a value it could not read", () => {
    for (const value of ["", "   ", "not a url", "postgresql:///only-a-path"]) {
      expect(resolveDatabaseTarget({ DATABASE_URL: value }).kind).not.toBe("local");
    }
  });
});

describe("describeDatabaseTarget", () => {
  it("names the host for a real target, so a refusal says what it refused", () => {
    expect(
      describeDatabaseTarget(
        resolveDatabaseTarget({ DATABASE_URL: "postgresql://u:p@db.example.co:5432/d" }),
      ),
    ).toBe("db.example.co");
  });

  it("names the host for a local target too, so a permitted run states where it wrote", () => {
    // The seed prints this line on every run, including the local ones that are
    // the common case. Only the remote arm was sampled, so the "local" switch
    // label was never taken.
    expect(
      describeDatabaseTarget(
        resolveDatabaseTarget({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/selectlub" }),
      ),
    ).toBe("127.0.0.1");
  });

  it("explains the absent and unparseable cases instead of naming a host", () => {
    expect(describeDatabaseTarget({ kind: "absent" })).toContain("not set");
    expect(describeDatabaseTarget({ kind: "unparseable", value: "x" })).toContain("readable URL");
  });
});
