/**
 * Test design (testing-strategy)
 *
 * Setup: walk apps/web/src for .ts / .tsx / .css. Match
 * /#[0-9A-Fa-f]{3,8}\b/. Skip theme.ts, theme.d.ts, and *.test.ts.
 *
 * Spec rule (openspec/specs/design-system/spec.md):
 *   Central theme is the only color source in product UI files.
 *
 * Partitions (one numbered group = files the spec treats the same):
 *
 *   P1 VALID   — theme module may contain #hex: theme.ts, theme.d.ts
 *   P2 VALID   — test files may contain #hex (they assert the palette)
 *   P3 INVALID — any other walked file matching the hex regex
 *                (Gallery.tsx `color: "#fff"` is the example)
 *
 * Output partitions:
 *   O1 — offenders === [] (P1/P2 skipped, P3 empty)
 *   O2 — path listed in offenders (P3 hit)
 *
 * Limits (boundary value analysis):
 *   Regex matches 3-digit (#fff) and 8-digit (#ffffffff).
 *   Two hex digits after #, or a bare "#", do not match.
 *
 * Map from each `it` to a partition:
 *
 *   keeps hex literals out of gallery and providers
 *     walk src → P3 offenders must be []
 *
 * What would make a test fail:
 *   `color: "#fff"` in Gallery.tsx (path appears in offenders)
 *
 * Production decisions: none. This suite walks source for hex literals.
 *
 * Not in this file: WCAG ratios (contrast.test.ts); visual QA of amber.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HEX_LITERAL = /#[0-9A-Fa-f]{3,8}\b/;
const ALLOWED = new Set(["theme.ts", "theme.d.ts"]);

function isTestFile(name: string) {
  return name.endsWith(".test.ts") || name.endsWith(".test.tsx");
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    if (![".ts", ".tsx", ".css"].includes(extname(entry))) {
      continue;
    }
    if (ALLOWED.has(entry) || isTestFile(entry)) {
      continue;
    }
    files.push(full);
  }
  return files;
}

describe("no hex outside the theme module", () => {
  it("keeps hex literals out of gallery and providers", () => {
    const srcRoot = import.meta.dirname;
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const source = readFileSync(file, "utf8");
      if (HEX_LITERAL.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("treats #fff as a hex literal and #ff as not", () => {
    expect(HEX_LITERAL.test("#ff")).toBe(false);
    expect(HEX_LITERAL.test("#fff")).toBe(true);
  });
});
