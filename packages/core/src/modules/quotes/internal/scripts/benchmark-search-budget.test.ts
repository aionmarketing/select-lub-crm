/**
 * Test design (testing-strategy): the benchmark's released caps and extra search cars
 * (switch-oil-research-to-openai task 3.3; owner decision 2026-10-12)
 *
 * SUT: effectiveCaps, buildPlan, formatPlan, capsOfPlan, CapGuard, parseSearchIdentity, parseArgs,
 *   searchCases and benchmarkMain (benchmark-plan.ts, benchmark-cases.ts). No socket: the global fetch
 *   is a spy that must never be called.
 *
 * Oracle: tasks.md 3.3 and design.md D9 as amended 2026-10-12. The production capture holds no stored
 *   excerpts and no manual readings, so a group with no cases releases its cap to the searches, and
 *   `--search-identity "<make>|<year>|<model>|<version>"` adds cars to the search group.
 *   - (a) US$ 0.20 and (b) US$ 0.30 are kept only by a group with cases; (c) gets US$ 1.00 minus the
 *     caps it kept, up to the whole US$ 1.00. The hard total, the worst-case-before-send admission
 *     and the OpenAI-only rule are unchanged, and the dry run prints the effective caps.
 *   - The flag is repeatable: four non-empty parts, a 4-digit year, at most 5 searches in total with
 *     the captured failing car, no repeated car.
 *
 * Cells
 *   effective caps| cases per group (a, b, c)          | (a) 0.20 and (b) 0.30 only with cases; (c) = 1.00 - those; none when c has no cases
 *   released plan | capture with no stored data       | (a) and (b) 0, (c) 1.00; printed; capsOfPlan hands them to the guard
 *   stored plan   | capture with passages and manuals | the groups' own caps, (c) 0.50
 *   guard         | (c) at 1.00, spent 0.50           | a 0.41 search admitted; US$ 1.00 still refuses at 0.70 + 0.41; a released (a) refuses any call
 *   flag parse    | valid / 3 parts / empty part / year 19 / year 2019.5 / missing value | identity / each refused with the value named
 *   search cases  | 1 captured + 3 extras / 5 extras / duplicate / none | appended in order / refused over 5 total / refused / unchanged (cut at 5)
 *   entry         | the owner's three flags           | exit 0, 4 searches, caps printed, no fetch; invalid flag or 6 searches exit 2, runPaid not called
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkMain,
  buildPlan,
  capsOfPlan,
  CapGuard,
  effectiveCaps,
  formatPlan,
  parseArgs,
  parseSearchIdentity,
  searchCases,
  worstCaseUsd,
  type BenchmarkCapture,
} from "./benchmark-plan.js";

const PASSAGE = "SAE 5W-40 … Quantidade de óleo do motor 3,3 litros";

const POLO_ROW: BenchmarkCapture["cache_rows"][number] = {
  id: "polo",
  make: "Volkswagen",
  year: 2021,
  model: "Polo",
  version: "1.0 TSI",
  viscosities: ["5W-40"],
  viscosity: "5W-40",
  classification: "VW 502 00",
  fill_liters: "3.300",
  fill_kind: "em_servico",
  fill_condition: "with_filter",
  source_publisher: "vw.com.br",
  source_document: "Manual Polo",
  source_page: "p. 238",
  source_authority: 1,
  source_url: "https://vw.com.br/polo.pdf",
  source_classification: "manufacturer_manual",
  source_excerpt: null,
  grade_sources: null,
};

const IDENTITIES: BenchmarkCapture["identities"] = [
  { identity_key: "2021|VOLKSWAGEN|POLO|10TSI", make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI", state: "verified", outcome: "verified" },
  { identity_key: "2021|FIAT|ARGO|10FIREFLY", make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly", state: "failed", outcome: "failed" },
];

/** The owner's real capture (2026-10-12): no stored excerpts, no manual readings, one failed real car. */
const EMPTY_STORED: BenchmarkCapture = {
  captured_at: "2026-10-12T00:00:00Z",
  cache_rows: [POLO_ROW],
  manual_readings: [],
  manual_documents: {},
  runs: [],
  identities: IDENTITIES,
};

/** A capture with one stored passage and one stored manual reading, so (a) and (b) have cases. */
const STORED: BenchmarkCapture = {
  ...EMPTY_STORED,
  cache_rows: [{ ...POLO_ROW, source_excerpt: PASSAGE }],
  manual_readings: [
    {
      id: "r1",
      url: "https://vw.com.br/polo.pdf",
      make: "Volkswagen",
      year: 2021,
      model: "Polo",
      version: "1.0 TSI",
      status: "verified",
      spec: { viscosityGrades: ["5W-40"], fillLiters: 3.3, fillCondition: "with_filter" },
      cited_page: "p. 238",
      excerpt: PASSAGE,
      read_by: "glm-5.3-flash",
      document_id: "doc-polo",
    },
  ],
  manual_documents: { "doc-polo": [{ page: 238, text: `Óleo do motor\n${PASSAGE}` }] },
};

const OWNER_FLAGS = ["--search-identity", "Toyota|2019|Corolla|XEi 2.0", "--search-identity", "Chevrolet|2020|Onix|1.0", "--search-identity", "Hyundai|2021|HB20|1.0"];

afterEach(() => {
  vi.restoreAllMocks();
});


describe("the released caps (owner, 2026-10-12)", () => {
  it.each([
    { cases: { a: 5, b: 2, c: 4 }, caps: { a: 0.2, b: 0.3, c: 0.5 } },
    { cases: { a: 0, b: 2, c: 4 }, caps: { a: 0, b: 0.3, c: 0.7 } },
    { cases: { a: 5, b: 0, c: 4 }, caps: { a: 0.2, b: 0, c: 0.8 } },
    { cases: { a: 0, b: 0, c: 4 }, caps: { a: 0, b: 0, c: 1 } },
    { cases: { a: 0, b: 0, c: 0 }, caps: { a: 0, b: 0, c: 0 } },
  ])("gives $cases the caps $caps", ({ cases, caps }) => {
    const got = effectiveCaps(cases);
    expect(got.a).toBeCloseTo(caps.a, 10);
    expect(got.b).toBeCloseTo(caps.b, 10);
    expect(got.c).toBeCloseTo(caps.c, 10);
    // The hard total never moves.
    expect(got.a + got.b + got.c).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("plans the whole US$ 1.00 for the searches when nothing is stored, and prints the effective caps", () => {
    const { plan } = buildPlan(EMPTY_STORED, "gpt-6.1-sol", "medium", [{ make: "Toyota", year: 2019, model: "Corolla", version: "XEi 2.0" }]);
    expect(plan.groups.map((g) => [g.id, g.cases, g.capUsd])).toEqual([["a", 0, 0], ["b", 0, 0], ["c", 2, 1]]);
    expect(plan.totalCapUsd).toBe(1);
    const text = formatPlan(plan).join("\n");
    expect(text).toContain("effective caps — (a) US$ 0.000 (no cases, released); (b) US$ 0.000 (no cases, released); (c) US$ 1.000 (own US$ 0.500, plus the released caps)");
    expect(capsOfPlan(plan)).toEqual({ a: 0, b: 0, c: 1 });
  });

  it("keeps group (c) at its own US$ 0.50 when (a) and (b) have cases", () => {
    const { plan } = buildPlan(STORED);
    expect(capsOfPlan(plan)).toEqual({ a: 0.2, b: 0.3, c: 0.5 });
    expect(formatPlan(plan).join("\n")).toContain("effective caps — (a) US$ 0.200; (b) US$ 0.300; (c) US$ 0.500");
  });

  it("admits against the released cap, still refuses at the total, and gives a released group nothing", () => {
    const { plan } = buildPlan(EMPTY_STORED);
    const guard = new CapGuard(plan.totalCapUsd, capsOfPlan(plan));
    guard.set("c", 0.5);
    // 0.5 + 0.408 passes the released (c) cap of 1.00; the default (c) cap of 0.50 would refuse it.
    expect(() => guard.admit("c", worstCaseUsd(3_000, { maxToolCalls: 3 }))).not.toThrow();
    const stock = new CapGuard();
    stock.set("c", 0.5);
    expect(() => stock.admit("c", 0.408)).toThrow(/group \(c\) cap/);
    guard.set("c", 0.7);
    // 0.7 + 0.408 would pass US$ 1.00: refused there (the released cap and the total coincide, so the group cap names it first).
    expect(() => guard.admit("c", 0.408)).toThrow(/spent US\$ 0\.7000 \+ worst case US\$ 0\.4080 > US\$ 1\.00/);
    expect(() => guard.admit("a", 0.001)).toThrow(/group \(a\) cap/);
  });
});

describe("--search-identity", () => {
  it("parses four non-empty parts and a 4-digit year", () => {
    expect(parseSearchIdentity("Toyota|2019|Corolla|XEi 2.0")).toEqual({ make: "Toyota", year: 2019, model: "Corolla", version: "XEi 2.0" });
    expect(parseSearchIdentity(" Hyundai | 2021 | HB20 | 1.0 ")).toEqual({ make: "Hyundai", year: 2021, model: "HB20", version: "1.0" });
  });

  it.each([
    ["Toyota|2019|Corolla", /four non-empty parts/],
    ["Toyota|2019|Corolla|XEi|extra", /four non-empty parts/],
    ["Toyota|2019||XEi 2.0", /four non-empty parts/],
    ["|2019|Corolla|XEi 2.0", /four non-empty parts/],
    ["", /four non-empty parts/],
    ["Toyota|19|Corolla|XEi 2.0", /4-digit/],
    ["Toyota|2019.5|Corolla|XEi 2.0", /4-digit/],
    ["Toyota|abcd|Corolla|XEi 2.0", /4-digit/],
  ])("refuses %j", (value, message) => {
    expect(() => parseSearchIdentity(value)).toThrow(message);
  });

  it("is repeatable on the command line, in order, and refuses a flag with no value", () => {
    expect(parseArgs(["--capture", "c.json", ...OWNER_FLAGS]).searchIdentities.map((i) => i.model)).toEqual(["Corolla", "Onix", "HB20"]);
    expect(parseArgs(["--capture", "c.json"]).searchIdentities).toEqual([]);
    expect(() => parseArgs(["--search-identity"])).toThrow(/four non-empty parts/);
  });

  it("appends the extras after the captured failing car, and leaves a run without extras unchanged", () => {
    const extras = OWNER_FLAGS.filter((_, i) => i % 2 === 1).map(parseSearchIdentity);
    const cases = searchCases(EMPTY_STORED.identities, extras);
    expect(cases.map((c) => [c.identity.make, c.identity.model])).toEqual([["Fiat", "Argo"], ["Toyota", "Corolla"], ["Chevrolet", "Onix"], ["Hyundai", "HB20"]]);
    expect(cases[0]!.storedOutcome).toBe("failed");
    expect(cases[1]!.storedOutcome).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => ({ identity_key: `k${i}`, make: "M", year: 2020, model: `X${i}`, version: "1", state: "failed", outcome: "failed" }));
    expect(searchCases(many)).toHaveLength(5);
  });

  it("refuses more than 5 searches in total, and a car that repeats another", () => {
    const five = Array.from({ length: 5 }, (_, i) => parseSearchIdentity(`Make${i}|2020|Model${i}|1.0`));
    expect(searchCases([], five)).toHaveLength(5);
    expect(() => searchCases(EMPTY_STORED.identities, five)).toThrow(/6 searches, at most 5/);
    expect(() => searchCases(EMPTY_STORED.identities, [parseSearchIdentity("fiat|2021|ARGO|1.0 firefly")])).toThrow(/already in the search group/);
    expect(() => searchCases([], [parseSearchIdentity("A|2020|B|C"), parseSearchIdentity("a|2020|b|c")])).toThrow(/already in the search group/);
  });
});

describe("the entry with the owner's three cars", () => {
  const run = async (argv: string[], capture: BenchmarkCapture = EMPTY_STORED) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runPaid = vi.fn(async () => undefined);
    const lines: string[] = [];
    const code = await benchmarkMain(["--capture", "c.json", ...argv], { env: {}, readFile: () => JSON.stringify(capture), log: (line) => lines.push(line), runPaid });
    return { code, lines: lines.join("\n"), runPaid, fetchSpy };
  };

  it("plans four searches under one US$ 1.00 cap, prints the caps and makes no call", async () => {
    const { code, lines, runPaid, fetchSpy } = await run(OWNER_FLAGS);
    expect(code).toBe(0);
    expect(lines).toContain("(c) OpenAI searches: 4 cases");
    expect(lines).toContain("(a) US$ 0.000 (no cases, released); (b) US$ 0.000 (no cases, released); (c) US$ 1.000");
    expect(lines).toContain("dry run — no call made");
    expect(runPaid).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hands the paid run the extra cars as search cases", async () => {
    const runPaid = vi.fn(async () => undefined);
    await benchmarkMain(["--capture", "c.json", "--run", ...OWNER_FLAGS], { env: { OPENAI_API_KEY: "k" }, readFile: () => JSON.stringify(EMPTY_STORED), log: () => undefined, runPaid });
    const cases = (runPaid.mock.calls[0] as unknown as [Array<{ group: string; identity: { model: string } }>])[0];
    expect(cases.filter((c) => c.group === "c").map((c) => c.identity.model)).toEqual(["Argo", "Corolla", "Onix", "HB20"]);
  });

  it("exits 2 on an invalid flag, or on more than 5 searches, before any paid run", async () => {
    const bad = await run(["--search-identity", "Toyota|19|Corolla|XEi 2.0"]);
    expect(bad.code).toBe(2);
    expect(bad.lines).toContain("4-digit");
    const six = await run(["--search-identity", "A|2020|B|1", "--search-identity", "C|2020|D|1", "--search-identity", "E|2020|F|1", "--search-identity", "G|2020|H|1", "--search-identity", "I|2020|J|1"]);
    expect(six.code).toBe(2);
    expect(six.lines).toContain("6 searches, at most 5");
    expect(six.runPaid).not.toHaveBeenCalled();
  });
});

