/**
 * Test design (testing-strategy)
 *
 * This package declares no dependency on the absorbed Motul package. Split from
 * `remainder.test.ts` (5.1d), whose other cases moved to the modules that own their
 * shapes; this one stays because it reads this package's own `package.json`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("MotulCompatibility", () => {
  it("does not declare a Motul package dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["@select-lub/motul"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@select-lub/motul"]).toBeUndefined();
  });
});
