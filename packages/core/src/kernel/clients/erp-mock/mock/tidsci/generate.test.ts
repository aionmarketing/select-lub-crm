/**
 * Test design (testing-strategy)
 *
 * Setup: skip unless TID_ARCHIVE_DATABASE_URL is set and CI is unset.
 *   Package tests in CI MUST NOT read tid_archive.
 *
 * Oracle: task 4.1 — generate dry-run OS count matches SELECT count(*) on
 *   NotaFiscalSaidas per schema when the archive is up.
 *
 * Out of scope in CI: live Docker tid_archive (this file skipIf).
 */
import { describe, expect, it } from "vitest";

const live =
  Boolean(process.env.TID_ARCHIVE_DATABASE_URL?.trim()) && process.env.CI !== "true";

describe.skipIf(!live)("tidsci:generate live archive", () => {
  it("maps one OS per NotaFiscalSaidas row across emp01–emp04", async () => {
    const { runTidsciGenerate } = await import("./generate.js");
    const summary = await runTidsciGenerate(["--limit", "0"], process.env);
    const nfTotal = Object.values(summary.nfCounts).reduce((sum, n) => sum + n, 0);
    expect(summary.serviceOrderCount).toBe(nfTotal);
  }, 120_000);
});
