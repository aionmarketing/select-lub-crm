/**
 * Test design (testing-strategy)
 *
 * Setup: call the two pure functions with literal strings. No filesystem, no
 * database, no second worktree needed.
 *
 * Spec rule (isolate-and-guard-database-targets):
 *   A git worktree SHALL resolve to a database distinct from every other
 *   worktree on the same machine. The .env copy SHALL point at that database
 *   without disturbing the credentials and prose it inherits.
 *
 * Partitions (one numbered group = inputs the spec treats the same):
 *
 *   P1 NAME/PLAIN     — a name already valid as an identifier
 *   P2 NAME/PUNCTUATED— hyphens and other punctuation, which an unquoted
 *                       Postgres identifier cannot contain
 *   P3 NAME/OVERLONG  — longer than the 63-byte identifier limit, where two
 *                       worktrees share a long prefix and differ only at the end
 *   P4 NAME/DEGENERATE— no alphanumeric characters at all
 *   P5 ENV/LOCAL SRC  — a database key already naming a local database
 *   P6 ENV/PRESERVED  — comments, unrelated keys, commented-out database keys
 *   P7 ENV/UNREADABLE — a database key whose value is not a URL
 *   P8 ENV/ABSENT     — no DATABASE_URL line at all
 *   P9 ENV/HOSTED SRC — a database key naming the HOSTED database, which is
 *                       what the main checkout's .env actually contains
 *   P10 ENV/DIRECT SET— DIRECT_URL present and uncommented, so the key is
 *                       exercised as a SET key and not only as a commented one
 *
 * Output partitions:
 *   O1 — a valid Postgres identifier: lowercase, no punctuation, <= 63 bytes
 *   O2 — distinct inputs give distinct outputs (P1-P4)
 *   O3 — the line targets the local endpoint and the derived database (P5, P7, P9)
 *   O4 — byte-identical for everything not a database key (P6)
 *   O5 — a DATABASE_URL line is appended (P8)
 *   O6 — DATABASE_URL_TEST names a DIFFERENT database from DATABASE_URL
 *
 * Limits: exactly 63 bytes is the boundary. A name landing on it must not be
 * truncated; one byte over must be. Both sides are asserted on the VALUE, not
 * only on the length — a needless truncation still satisfies `length <= 63`.
 *
 * Map from each `it` to a partition:
 *
 *   keeps a plain name                        — P1 -> O1
 *   replaces punctuation                      — P2 -> O1
 *   distinguishes worktrees sharing a prefix  — P3 -> O2 (the collision case)
 *   stays within the identifier limit         — P3 -> O1
 *   keeps a name landing exactly on 63 bytes  — P1 -> O1 (boundary)
 *   truncates and hashes at 64 bytes          — P3 -> O1 (boundary + 1)
 *   handles a name with nothing usable        — P4 -> O1, O2
 *   points database keys at the new database  — P5 -> O3
 *   preserves comments and other keys         — P6 -> O4
 *   leaves a commented key commented          — P6 -> O4
 *   repoints DIRECT_URL when it is set        — P10 -> O3
 *   replaces an unreadable value              — P7 -> O3
 *   points at LOCAL when the source is hosted — P9 -> O3 (regression)
 *   gives DATABASE_URL_TEST its own database  — P5 -> O6
 *   appends DATABASE_URL when absent          — P8 -> O5
 *
 * One-sided by construction: `if (key === undefined) return line` in
 * rewriteEnvForWorktree. The regex that produced `match` has a mandatory first
 * capture group, so a successful match always has a group 1; the check exists
 * only because `noUncheckedIndexedAccess` types the index access as possibly
 * undefined. Infeasible with legal input, so no hollow case is added for it.
 *
 * What would make a test fail:
 *   Truncating without a hash, which would map two real worktree names in this
 *   repo to one database and silently reunite the data this change separates.
 *   Editing the inherited URL instead of rebuilding it, which leaves a worktree
 *   pointed at the hosted host — the bug P9 exists to catch, and the one the
 *   original all-local fixture could not see. Rewriting a commented DIRECT_URL,
 *   which would switch on a direct connection local Compose does not need.
 *   Dropping the service-role key or Evolution credentials the copy carries.
 *   Pointing DATABASE_URL_TEST at the same database as DATABASE_URL, which the
 *   API suite would then truncate. Dropping DIRECT_URL from DATABASE_ENV_KEYS,
 *   which leaves a worktree migrating the HOSTED database through the direct
 *   connection while its DATABASE_URL reads the local one.
 */
import { describe, expect, it } from "vitest";
import {
  buildLocalDatabaseUrl,
  deriveWorktreeDatabaseName,
  rewriteEnvForWorktree,
} from "./worktree-database.js";

describe("deriveWorktreeDatabaseName", () => {
  it("keeps a plain name, prefixed", () => {
    expect(deriveWorktreeDatabaseName("scratch")).toBe("selectlub_scratch");
  });

  it("replaces punctuation an unquoted identifier cannot contain", () => {
    expect(deriveWorktreeDatabaseName("active-sessions.pending")).toBe(
      "selectlub_active_sessions_pending",
    );
    expect(deriveWorktreeDatabaseName("UPPER-Case")).toBe("selectlub_upper_case");
  });

  it("distinguishes worktrees that share a long prefix", () => {
    // The real shape in this repo: a long descriptive name plus a short hash.
    // Plain truncation at 63 bytes would map both of these to one database.
    const a = deriveWorktreeDatabaseName(
      "active-sessions-pending-tasks-with-a-very-long-descriptive-name-a7b368",
    );
    const b = deriveWorktreeDatabaseName(
      "active-sessions-pending-tasks-with-a-very-long-descriptive-name-0233b1",
    );
    expect(a).not.toBe(b);
  });

  it.each([
    ["short", "scratch"],
    ["exactly at the limit", "a".repeat(63 - "selectlub_".length)],
    ["over the limit", "b".repeat(200)],
    ["long and punctuated", "worktree-".repeat(30)],
  ])("stays a valid identifier when %s", (_label, name) => {
    const result = deriveWorktreeDatabaseName(name);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("keeps a name that lands exactly on the 63-byte limit whole", () => {
    // BVA, the limit itself. A `<` where the code has `<=` truncates this name
    // and appends a hash for no reason — still valid, so the length assertion
    // above cannot see it.
    const slug = "a".repeat(63 - "selectlub_".length);

    expect(deriveWorktreeDatabaseName(slug)).toBe(`selectlub_${slug}`);
  });

  it("truncates and hashes a name one byte over the limit", () => {
    // BVA, limit + 1: the first input the branch above must NOT take. Between
    // this case and the one above, an off-by-one in either direction fails.
    const slug = "a".repeat(63 - "selectlub_".length + 1);

    const result = deriveWorktreeDatabaseName(slug);

    expect(result).not.toBe(`selectlub_${slug}`);
    expect(result).toHaveLength(63);
    expect(result).toMatch(/^selectlub_a+_[0-9a-f]{8}$/);
  });

  it("still produces a usable, distinct name when nothing is alphanumeric", () => {
    const a = deriveWorktreeDatabaseName("---");
    const b = deriveWorktreeDatabaseName("...");
    expect(a).toMatch(/^selectlub_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildLocalDatabaseUrl", () => {
  it("always targets the local Compose endpoint", () => {
    expect(buildLocalDatabaseUrl("selectlub_wt")).toBe(
      "postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt",
    );
  });

  it("uses credentials from the file when they are customised", () => {
    expect(buildLocalDatabaseUrl("db", { user: "alice", password: "p@ss word" })).toBe(
      "postgresql://alice:p%40ss%20word@127.0.0.1:5433/db",
    );
  });
});

describe("rewriteEnvForWorktree", () => {
  const env = [
    "POSTGRES_USER=selectlub",
    "POSTGRES_DB=selectlub",
    "DATABASE_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub",
    "# Migrate/direct connection. Local Compose can reuse DATABASE_URL.",
    "# DIRECT_URL=",
    "SUPABASE_SERVICE_ROLE_KEY=super-secret-value",
    "EVOLUTION_WEBHOOK_SECRET=another-secret",
  ].join("\n");

  it("points the database keys at the new database", () => {
    const result = rewriteEnvForWorktree(env, "selectlub_wt");
    expect(result).toContain(
      "DATABASE_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt",
    );
    expect(result).toContain("POSTGRES_DB=selectlub_wt");
  });

  it("preserves the credentials and prose the copy inherits", () => {
    const result = rewriteEnvForWorktree(env, "selectlub_wt");
    expect(result).toContain("SUPABASE_SERVICE_ROLE_KEY=super-secret-value");
    expect(result).toContain("EVOLUTION_WEBHOOK_SECRET=another-secret");
    expect(result).toContain("POSTGRES_USER=selectlub");
    expect(result).toContain("# Migrate/direct connection. Local Compose can reuse DATABASE_URL.");
  });

  it("leaves a commented-out database key commented", () => {
    // Uncommenting DIRECT_URL would switch on a direct connection local Compose
    // does not need.
    expect(rewriteEnvForWorktree(env, "selectlub_wt")).toContain("# DIRECT_URL=");
  });

  it("repoints DIRECT_URL when the source actually sets it", () => {
    // The other DIRECT_URL case only proves a COMMENTED key is left alone,
    // which holds for any key at all. Nothing exercised DIRECT_URL as a set
    // key, so deleting it from DATABASE_ENV_KEYS failed no test — and a
    // worktree would then inherit a direct connection to the hosted database
    // while its DATABASE_URL pointed at the local one. Prisma migrations use
    // DIRECT_URL, so that inheritance would migrate the wrong database.
    const source = [
      "DATABASE_URL=postgresql://postgres:hosted@db.example.supabase.co:5432/postgres",
      "DIRECT_URL=postgresql://postgres:hosted@db.example.supabase.co:5432/postgres",
    ].join("\n");

    const result = rewriteEnvForWorktree(source, "selectlub_wt");

    // No POSTGRES_USER/PASSWORD in this fixture, so the documented defaults apply.
    expect(result).toContain(
      "DIRECT_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt",
    );
    expect(result).not.toContain("supabase.co");
  });

  it("replaces an unreadable connection string with a usable local one", () => {
    // The inherited value is never parsed — the endpoint is rebuilt from
    // scratch — so a malformed URL in the main checkout's .env cannot
    // propagate into the worktree.
    expect(rewriteEnvForWorktree("DATABASE_URL=not-a-url", "selectlub_wt")).toBe(
      "DATABASE_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt",
    );
  });

  it("points a worktree at LOCAL Postgres even when the source names a hosted database", () => {
    // Regression. The main checkout's .env names the hosted Supabase instance,
    // and an earlier version swapped only the database out of that URL — leaving
    // the worktree still aimed at the hosted host, with the isolation this
    // change exists to create silently absent. The original fixture could not
    // catch it because its source URL was already local.
    const hosted = [
      "POSTGRES_USER=postgres",
      "POSTGRES_PASSWORD=hosted-secret",
      "DATABASE_URL=postgresql://postgres:hosted-secret@db.example.supabase.co:5432/postgres",
      "DATABASE_URL_TEST=postgresql://postgres:hosted-secret@db.example.supabase.co:5432/testing",
    ].join("\n");

    const result = rewriteEnvForWorktree(hosted, "selectlub_wt");

    expect(result).not.toContain("supabase.co");
    expect(result).toContain(
      "DATABASE_URL=postgresql://postgres:hosted-secret@127.0.0.1:5433/selectlub_wt",
    );
  });

  it("gives DATABASE_URL_TEST a different database, since the suite truncates it", () => {
    const source = [
      "DATABASE_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub",
      "DATABASE_URL_TEST=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_test",
    ].join("\n");

    const result = rewriteEnvForWorktree(source, "selectlub_wt");

    expect(result).toContain("DATABASE_URL=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt");
    expect(result).toContain(
      "DATABASE_URL_TEST=postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_wt_test",
    );
  });

  it("appends DATABASE_URL when the file has none", () => {
    const result = rewriteEnvForWorktree("POSTGRES_USER=selectlub", "selectlub_wt");
    expect(result).toContain("DATABASE_URL=");
    expect(result).toContain("/selectlub_wt");
  });

  it("preserves CRLF line endings", () => {
    const crlf = "POSTGRES_USER=selectlub\r\nDATABASE_URL=postgresql://u:p@127.0.0.1:5433/x";
    const result = rewriteEnvForWorktree(crlf, "selectlub_wt");
    expect(result).toContain("\r\n");
    expect(result.split("\r\n")).toHaveLength(2);
  });
});
