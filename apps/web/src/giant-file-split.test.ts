/**
 * Test design (testing-strategy)
 *
 * This file walks source and CI YAML. It has no production decision of
 * its own — it does not execute ConversasPage, buildApp, or any helper.
 *
 * Oracle: openspec/changes/harden-giant-file-branch-coverage
 * specs/repo-foundation — oversized mixed-capability files are split;
 * public imports stay; single-capability / named-non-goal files stay;
 * coverage percent stays a finder (no CI percent gate).
 *
 * Axes
 *   A1 module — Conversas page / API composition root / keep-list / CI
 *   A2 expected string — present vs forbidden
 *
 * Outputs
 *   O1 public export still declared
 *   O2 region / resource handlers not defined inline
 *   O3 keep-list files still exist as those paths
 *   O4 CI runs coverage without a percent threshold
 *
 * Sampled-cell
 *   Conversas page import     | A1 page     | O1 | ConversasPage removed
 *   seven regions not in page | A1 page     | O2 | ThreadPane defined here
 *
 * The page is now a build-time variant selector (build-time-ui-variant), so O1
 * accepts either declaration form — the requirement fixes the public import
 * path, not how the symbol is declared — and O2 walks the selector plus both
 * variant siblings, so moving a region into one of them still fails.
 *   buildApp still in app.ts  | A1 api      | O1 | factory moved
 *   resources not inline      | A1 api      | O2 | app.post("/conversations"
 *   keep files unsplit        | A1 keep     | O3 | Relatórios extracted
 *   CI no coverage %          | A1 ci       | O4 | coverageThreshold added
 *
 * Not automated (process obligation, checked in apply notes):
 *   Scenario "Finder can add another split target" — apply-time finder
 *   writes the reason when a new file meets both criteria (`api.ts` did).
 *
 * Out of scope: leftover T/F inside the extracted modules (helpers.test.ts,
 * ConversasPage.* / inject suites); product behavior.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = import.meta.dirname;
const repoRoot = join(srcRoot, "../../..");

function read(rel: string) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("giant-file split (source walk)", () => {
  it("keeps ConversasPage as the documented public export and does not define the seven regions there", () => {
    const app = read("apps/web/src/App.tsx");

    // The public path is the selector; the composition itself lives in the
    // per-variant siblings. The requirement fixes the import path, not the
    // declaration form, so a `const` selector satisfies it as a `function` did.
    expect(read("apps/web/src/ConversasPage.tsx")).toMatch(
      /export (function|const) ConversasPage\b/,
    );
    expect(app).toMatch(/from ["']\.\/ConversasPage\.js["']/);

    // Every module reachable through that path must stay free of the regions,
    // otherwise a variant sibling becomes the new giant file.
    for (const rel of [
      "apps/web/src/ConversasPage.tsx",
      "apps/web/src/ConversasPage.cursor.tsx",
      "apps/web/src/ConversasPage.antigravity.tsx",
    ]) {
      const page = read(rel);

      expect(page, rel).not.toContain("function ConversationList");
      expect(page, rel).not.toContain("function ThreadPane");
      expect(page, rel).not.toContain("function ContactRail");
      expect(page, rel).not.toContain("function VehicleRailRow");
      expect(page, rel).not.toContain("function OilQuoteDialog");
      expect(page, rel).not.toContain("function ScheduleMessageDialog");
      expect(page, rel).not.toContain("function PrefillRail");
    }
  });

  it("keeps buildApp as the documented factory and registers resources from separate modules", () => {
    const app = read("apps/api/src/app.ts");

    expect(app).toMatch(/export async function buildApp/);
    expect(app).toContain("@select-lub/core/modules/accounts");
    // Conversations, tags and Follow-up are one module since adopt-modular-vertical-slices
    // 4A: the app mounts them through the module import, not three per-resource route registrars.
    expect(app).toContain("@select-lub/core/modules/conversations");
    // The cadastro is the customers module since adopt-modular-vertical-slices 4B.
    expect(app).toContain("@select-lub/core/modules/customers");
    expect(app).toContain("@select-lub/core/modules/services");
    // Oil quotes are a module since adopt-modular-vertical-slices 2B (W2-C11): the app
    // mounts it through the module import, not a per-resource route registrar.
    expect(app).toContain('from "@select-lub/core/modules/quotes"');
    expect(app).toContain("@select-lub/core/modules/reports");
    expect(app).toContain("@select-lub/core/modules/scheduling");
    expect(app).toContain("@select-lub/core/modules/prefill");

    expect(app).not.toContain('app.post("/conversations"');
    expect(app).not.toContain('app.get("/conversations"');
    expect(app).not.toContain('app.get("/reports/conversations"');
    expect(app).not.toContain('app.get("/follow-ups"');
  });

  it("leaves single-capability and named-non-goal files unsplit", () => {
    expect(existsSync(join(repoRoot, "apps/web/src/RelatoriosPage.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/web/src/ConfiguracoesPage.tsx"))).toBe(true);
    // The cadastro engine was split in 5.1b under core's 300-line rule
    // (adopt-modular-vertical-slices), not under this requirement, which only says
    // it MUST NOT be split for coverage. Its entry points stay one import.
    expect(
      existsSync(join(repoRoot, "packages/core/src/modules/customers/contracts/cadastro-engine/index.ts")),
    ).toBe(true);
    // Moved whole into the conversations module in 4A, still one file.
    expect(existsSync(join(repoRoot, "packages/core/src/modules/conversations/internal/parse.ts"))).toBe(true);
    // The live Omie HTTP adapter, a named leftover: moved into the kernel in 5.1b. The
    // adapter stays whole in http.ts; its wire helpers went to http-wire.ts under core's
    // 300-line rule, not under this requirement.
    expect(existsSync(join(repoRoot, "packages/core/src/kernel/clients/erp-mock/http.ts"))).toBe(true);

    expect(existsSync(join(repoRoot, "apps/web/src/relatorios"))).toBe(false);
  });

  it("keeps the workspace coverage job as a finder with no percent gate", () => {
    const ci = read(".github/workflows/ci.yml");
    const vitest = read("vitest.config.ts");

    expect(ci).toContain("pnpm test:coverage");
    expect(ci).not.toContain("coverageThreshold");
    expect(ci).not.toMatch(/fail_ci_if_error\s*:\s*true/);
    expect(vitest).not.toContain("coverageThreshold");
  });
});
