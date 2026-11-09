/**
 * Test design — no in-memory store exists
 *
 * SUT: the repository tree. The repo-foundation requirement "No in-memory
 *   store exists to fall back to" (route-tests-on-real-database) is a claim
 *   about files, so it is checked as one: no `memory.ts` under any
 *   `apps/<x>/src` or `packages/<x>/src`.
 * Why a file check and not a grep for `createMemory`: the name is convention,
 *   the file is the artifact. Every fake this change deleted lived in a
 *   `memory.ts`, and a new one would most naturally be created under the same
 *   name. A decoy case proves the finder sees such a file when one exists, so
 *   an empty result is a positive finding rather than a broken walk.
 * Out of scope: fakes under other names. Those are caught by review, and by
 *   `buildApp` having no arm that accepts one.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Directories a walk must not descend into: not source, and enormous. */
const SKIPPED = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Walks up from this file to the directory holding the workspace manifest. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${dir}`);
    dir = parent;
  }
  return dir;
}

/** Every `memory.ts` under the src folder of each app and package, repo-relative with forward slashes. */
function findMemoryStores(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name === "memory.ts") {
        found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
      const src = join(groupDir, pkg.name, "src");
      if (pkg.isDirectory() && existsSync(src)) walk(src);
    }
  }
  return found.sort();
}

describe("no in-memory store exists to fall back to", () => {
  it("finds no memory.ts under any app or package source tree", () => {
    expect(findMemoryStores(repoRoot())).toEqual([]);
  });

  describe("the finder itself", () => {
    let decoyRoot: string | undefined;
    afterEach(() => {
      if (decoyRoot) rmSync(decoyRoot, { recursive: true, force: true });
      decoyRoot = undefined;
    });

    it("reports a memory.ts when one exists, so the empty result above is a finding", () => {
      decoyRoot = mkdtempSync(join(tmpdir(), "no-memory-store-"));
      mkdirSync(join(decoyRoot, "apps", "decoy", "src", "deep"), { recursive: true });
      mkdirSync(join(decoyRoot, "packages", "decoy", "src", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(decoyRoot, "apps", "decoy", "src", "deep", "memory.ts"), "export {};\n");
      // Under node_modules: must be skipped, or a dependency's file would fail the repo.
      writeFileSync(join(decoyRoot, "packages", "decoy", "src", "node_modules", "dep", "memory.ts"), "export {};\n");

      expect(findMemoryStores(decoyRoot)).toEqual(["apps/decoy/src/deep/memory.ts"]);
    });
  });
});
