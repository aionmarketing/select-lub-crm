/**
 * A mock Omie source whose every identifier is unique to one test (the #163
 * follow-up).
 *
 * The mock dataset is small and fixed, and the demo seed writes the same ids. So
 * when every surface test imported it as-is, all of them upserted the same
 * `customer`, `service`, `vehicle` and catalog rows, and each waited for the
 * others' transactions to release those rows: single cases took up to ~6 s alone,
 * and a loaded root run pushed them past the 30 s default. With every id prefixed
 * per test, no two tests, and no test and the seed, write the same row.
 */
import { randomUUID } from "node:crypto";
import { createMockOmie, mockOmieDataset, prefixMockOmieIds, type MockOmieSource } from "../../../../kernel/clients/erp-mock.js";

/** A fresh prefix, and the id a mock dataset id has under it. */
export type ScopedIds = (omieId: string) => string;

/**
 * A mock source over the dataset with every Omie id prefixed for this test.
 *
 * @param env - As for `createMockOmie`; defaults to `process.env`.
 * @returns The source; `id`, which maps a dataset id (`"omie-mock-linked"`,
 *   `"os-mock-1"`, …) to the id this source uses for it; and `another`, a fresh
 *   source under the SAME ids, for a case that re-imports what a first source did;
 *   and `data`, the built-in dataset under those ids, for a case that seeds rows
 *   before it imports.
 */
export function scopedMockOmie(env: NodeJS.ProcessEnv = process.env): {
  source: MockOmieSource;
  id: ScopedIds;
  another: () => MockOmieSource;
  data: () => ReturnType<typeof mockOmieDataset>;
} {
  const prefix = `t${randomUUID().replace(/-/g, "").slice(0, 8)}-`;
  const another = () => createMockOmie(env, { idPrefix: prefix });
  return {
    source: another(),
    id: (omieId) => `${prefix}${omieId}`,
    another,
    data: () => prefixMockOmieIds(mockOmieDataset(), prefix),
  };
}
