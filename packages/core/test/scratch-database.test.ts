/**
 * Test design (testing-strategy) — the scratch database's name and URL, pure.
 *
 * SUT: `scratchDatabaseUrl`, `quoteIdentifier` (scratch-database.ts). Creating and
 * dropping the database is exercised by `demo-seed.live.test.ts`, which uses it.
 *
 * Oracle: the scratch must be on the same server and credentials as the base,
 * differ only in the database, fit Postgres's 63-character identifier limit
 * (longer names are truncated silently, which would break DROP), and stay unique
 * per base name when shortened.
 *
 * Axes: A1 base name short / long; A2 password plain / with `@` and `/`; A3
 *   identifier with a double quote.
 */
import { describe, expect, it } from "vitest";
import { createScratchDatabase, quoteIdentifier, scratchDatabaseUrl } from "./scratch-database.js";

describe("scratchDatabaseUrl", () => {
  it("keeps server, credentials and query, and changes only the database", () => {
    const { name, url } = scratchDatabaseUrl(
      "postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_test?schema=public",
      "demo_seed_live",
    );
    expect(name).toBe("selectlub_test_demo_seed_live");
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).toBe("5433");
    expect(parsed.username).toBe("selectlub");
    expect(parsed.password).toBe("selectlub");
    expect(parsed.pathname).toBe("/selectlub_test_demo_seed_live");
    expect(parsed.search).toBe("?schema=public");
  });

  it("parses a password holding @ and / instead of splitting on them", () => {
    const base = "postgresql://user:p%40ss%2Fw0rd@127.0.0.1:5433/crm";
    const { url } = scratchDatabaseUrl(base, "demo_seed_live");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/w0rd");
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.pathname).toBe("/crm_demo_seed_live");
  });

  it("fits a long base name under 63 characters, keeping the suffix and a per-base hash", () => {
    const long = "selectlub_assistant_session_with_a_very_long_worktree_name_1234";
    const other = "selectlub_assistant_session_with_a_very_long_worktree_name_5678";
    const a = scratchDatabaseUrl(`postgresql://u:p@127.0.0.1:5433/${long}`, "demo_seed_live");
    const b = scratchDatabaseUrl(`postgresql://u:p@127.0.0.1:5433/${other}`, "demo_seed_live");
    expect(a.name.length).toBeLessThanOrEqual(63);
    expect(a.name.endsWith("_demo_seed_live")).toBe(true);
    // The two bases share their first 38 characters; the hash keeps them apart.
    expect(a.name).not.toBe(b.name);
  });

  it("refuses a URL that names no database", () => {
    expect(() => scratchDatabaseUrl("postgresql://u:p@127.0.0.1:5433/", "x")).toThrow(/names no database/);
  });
});

describe("createScratchDatabase's own host guard", () => {
  // Every case refuses before any client is built, so none reaches a server.
  it.each([
    ["a hosted database", "postgresql://u:p@db.hosted.invalid:5432/postgres"],
    ["an unset DATABASE_URL", ""],
    ["an unparseable one", "not a url"],
  ])("refuses %s", async (_label, baseUrl) => {
    await expect(createScratchDatabase(baseUrl, "demo_seed_live", ".", {})).rejects.toThrow(/refusing to create/);
  });

  it("names the host it refused", async () => {
    await expect(
      createScratchDatabase("postgresql://u:p@db.hosted.invalid:5432/postgres", "demo_seed_live", ".", {}),
    ).rejects.toThrow(/refusing to create a database next to .*db\.hosted\.invalid/);
  });
});

describe("quoteIdentifier", () => {
  it("quotes a name and doubles an embedded double quote", () => {
    expect(quoteIdentifier("crm_demo_seed_live")).toBe('"crm_demo_seed_live"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});
