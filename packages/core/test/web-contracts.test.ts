/**
 * Test design (testing-strategy) — the web contract stays web-safe
 *
 * SUT: the import graph reachable from `packages/core/src/contracts.ts`, the
 *   entry `@select-lub/shared-types` re-exports to `apps/web` (5.1d).
 * Oracle: 5.1d ruling D1 — everything the browser bundle reaches is pure: module
 *   `contracts/http*.ts` and `shared/web/*.ts` only, importing nothing from a
 *   package but `zod`; each exported name declared in exactly one file (an
 *   `export *` conflict silently drops a name); and no runtime import cycle among
 *   them (a cycle over `const` zod schemas fails at load, in the browser too).
 * Why a test as well as the lint rule: the lint rule checks each file's own
 *   import lines; this walks the chain the bundler follows, so a file the lint
 *   rule does not cover but the graph reaches is still caught.
 * Positive controls (every run): the same walk over the real files with one file
 *   rewritten IN MEMORY — importing `node:crypto`, importing the kernel, and
 *   redeclaring an existing name — must report each violation. A walk that never
 *   reads what it claims to check would pass the real graph and fail these.
 * Reach control: the walk must reach every module's http contract and
 *   `shared/web`, so an entry that silently resolves to nothing cannot pass.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ENTRY = resolve(SRC, "contracts.ts");

type Read = (file: string) => string;
type Walk = { files: string[]; violations: string[] };

const rel = (file: string) => relative(SRC, file).split("\\").join("/");

function isWebSafeFile(file: string): boolean {
  const r = rel(file);
  return (
    r === "contracts.ts" ||
    /^modules\/[a-z-]+\/contracts\/http(\.[a-z-]+)?\.ts$/.test(r) ||
    /^shared\/web\/[a-z-]+\.ts$/.test(r)
  );
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const ts = base.replace(/\.js$/, ".ts");
  if (existsSync(ts)) return ts;
  return resolve(base, "index.ts");
}

/** Walks the graph from `entry`, reading each file through `read`. */
function walkWebGraph(entry: string, read: Read): Walk {
  const violations: string[] = [];
  const seen = new Set<string>();
  const runtimeEdges = new Map<string, string[]>();
  const declaredIn = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!isWebSafeFile(file)) violations.push(`reaches a non-web file: ${rel(file)}`);
    const code = stripComments(read(file));
    for (const m of code.matchAll(/^export (?:declare )?(?:async )?(?:const|let|function|type|interface|enum|class) ([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1]!;
      const other = declaredIn.get(name);
      if (other && other !== file) violations.push(`"${name}" is declared in ${rel(other)} and ${rel(file)}`);
      declaredIn.set(name, file);
    }
    const edges: string[] = [];
    // Static `import`/`export … from`, and — because the bundler follows them too —
    // dynamic `import("…")` and `require("…")`. Every one is a runtime edge except
    // a static `import type` / `export type`.
    const specs: { spec: string; typeOnly: boolean }[] = [];
    for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)) {
      specs.push({ spec: m[3]!, typeOnly: Boolean(m[2]) });
    }
    for (const m of code.matchAll(/(?<![\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      specs.push({ spec: m[1]!, typeOnly: false });
    }
    if (/(?<![\w$.])(?:import|require)\s*\(\s*(?!["'][^"']+["']\s*\))/.test(code)) {
      violations.push(`${rel(file)} has a dynamic import or require whose specifier is not a string literal`);
    }
    for (const { spec, typeOnly } of specs) {
      if (!spec.startsWith(".")) {
        if (spec !== "zod") violations.push(`${rel(file)} imports the package "${spec}"`);
        continue;
      }
      const target = resolveRelative(file, spec);
      if (!typeOnly) edges.push(target);
      queue.push(target);
    }
    runtimeEdges.set(file, edges);
  }
  // Runtime cycles.
  const state = new Map<string, "open" | "done">();
  const visit = (file: string, trail: string[]) => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "open") {
      violations.push(`runtime import cycle: ${[...trail.slice(trail.indexOf(file)), file].map(rel).join(" -> ")}`);
      return;
    }
    state.set(file, "open");
    for (const next of runtimeEdges.get(file) ?? []) visit(next, [...trail, file]);
    state.set(file, "done");
  };
  for (const file of runtimeEdges.keys()) visit(file, []);
  return { files: [...seen].map(rel).sort(), violations };
}

const onDisk: Read = (file) => readFileSync(file, "utf8");

/** The real files, with `target` read as its real text plus `extra`. */
function planted(target: string, extra: string): Read {
  const abs = resolve(SRC, target);
  return (file) => (file === abs ? `${onDisk(file)}\n${extra}\n` : onDisk(file));
}

describe("the web contract (@select-lub/core/contracts)", () => {
  const walk = walkWebGraph(ENTRY, onDisk);

  it("reaches every module's http contract and shared/web", () => {
    for (const mod of ["accounts", "channel", "conversations", "customers", "plate-lookup", "prefill", "quotes", "reports", "scheduling", "services"]) {
      expect(walk.files).toContain(`modules/${mod}/contracts/http.ts`);
    }
    for (const file of ["build-identity", "omie-field-keys", "source-classification"]) {
      expect(walk.files).toContain(`shared/web/${file}.ts`);
    }
    expect(walk.files.length).toBeGreaterThanOrEqual(40);
  });

  it("reaches only web-safe files, imports only zod, declares each name once, and has no runtime cycle", () => {
    expect(walk.violations).toEqual([]);
  });
});

describe("the walk sees what it guards (positive controls)", () => {
  const TARGET = "modules/customers/contracts/http.customer.ts";

  it("reports a planted node:crypto import", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'import { randomUUID } from "node:crypto";'));
    expect(walk.violations).toContain(`${TARGET} imports the package "node:crypto"`);
  });

  it("reports a planted kernel import", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'import { createDb } from "../../../kernel/db.js";'));
    expect(walk.violations).toContain("reaches a non-web file: kernel/db.ts");
  });

  it("reports a planted dynamic import of node:crypto", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'export const later = () => import("node:crypto");'));
    expect(walk.violations).toContain(`${TARGET} imports the package "node:crypto"`);
  });

  it("reports a planted require of node:crypto", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'export const legacy = () => require("node:crypto");'));
    expect(walk.violations).toContain(`${TARGET} imports the package "node:crypto"`);
  });

  it("reports a dynamic import whose specifier is computed", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'const name = "node:crypto";\nexport const later = () => import(name);'));
    expect(walk.violations).toContain(`${TARGET} has a dynamic import or require whose specifier is not a string literal`);
  });

  it("reports a planted runtime self-import as a cycle", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'import "./http.customer.js";'));
    expect(walk.violations).toContain(`runtime import cycle: ${TARGET} -> ${TARGET}`);
  });

  it("does not count a type-only self-import as a cycle (it is erased)", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, 'import type { Customer as Again } from "./http.customer.js";\nexport type SameCustomer = Again;'));
    expect(walk.violations.filter((v) => v.startsWith("runtime import cycle"))).toEqual([]);
  });

  it("reports a name declared a second time", () => {
    const walk = walkWebGraph(ENTRY, planted(TARGET, "export const vehicleSchema = 1;"));
    expect(walk.violations.some((v) => v.startsWith('"vehicleSchema" is declared in'))).toBe(true);
  });
});
