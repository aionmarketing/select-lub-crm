/**
 * Test design (testing-strategy)
 *
 * Setup: walk apps/web/src .ts/.tsx. LOCAL_SHAPE matches a local
 * `type` / `interface` of ConversationSummary | ConversationMessage |
 * SendTextBody | TagSummary | OutboxStatus | ChannelStatus followed by
 * `=` or `{`. Skip *.test.ts, *.test.tsx, *.d.ts.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md — Shared Conversas contract):
 *   Product files import those shapes from @select-lub/shared-types.
 *   They must not declare a parallel copy.
 *
 * Partitions (one numbered group = source lines the spec treats the same):
 *
 *   P1 VALID   — import from shared-types:
 *                `import { type ConversationSummary } from "..."`
 *   P2 INVALID — local declaration of any of those names:
 *                `type ConversationSummary = { ... }`
 *                (one name is enough; no extra `it` per name)
 *   P3 VALID   — skipped files: tests and .d.ts may mention the names
 *
 * Output partitions:
 *   O1 — offenders === [] (P1/P3 only)
 *   O2 — file path in offenders (P2)
 *
 * Limits: none — local declaration present or not. 0 vs 1 vs 2 copies
 * is the same miss. Regex requires `=` or `{` so
 * `import type { ConversationSummary,` is not a declaration.
 *
 * Map from each `it` to a partition:
 *
 *   does not declare parallel list/message/send types in apps/web/src
 *     walk src → P2 offenders must be []
 *
 * What would make a test fail:
 *   `type ConversationSummary = { id: string }` in ConversasPage.tsx
 *
 * Production decisions: none. This suite greps for parallel type declarations.
 *
 * Not in this file: parsing live GET JSON (shared-types index.test.ts
 * and api.ts parse()).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const LOCAL_SHAPE =
  /^\s*(?:export\s+)?(?:type|interface)\s+(?:ConversationSummary|ConversationMessage|SendTextBody|TagSummary|OutboxStatus|ChannelStatus)\s*[{=]/m;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry))) {
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx") || entry.endsWith(".d.ts")) {
      continue;
    }
    files.push(full);
  }
  return files;
}

describe("shared Conversas contract", () => {
  it("does not declare parallel list/message/send types in apps/web/src", () => {
    const offenders: string[] = [];
    for (const file of walk(import.meta.dirname)) {
      if (LOCAL_SHAPE.test(readFileSync(file, "utf8"))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
