/**
 * Test design (testing-strategy): the OpenAI benchmark's guards, plan and caps (switch-oil-research-to-openai task 2.1)
 *
 * SUT: benchmarkMain, refusal, buildPlan and its case builders, worstCaseUsd, CapGuard (benchmark-plan.ts),
 *   and guardedTransport (benchmark-openai-run.ts). No socket: the global fetch is a spy that must never
 *   be called, and the guarded transport's base is a fake.
 *
 * Oracle: tasks.md 2.1 and design.md D9.
 *   - A dry run is the default and makes no call.
 *   - A paid run needs `--run` and `OPENAI_API_KEY`.
 *   - OpenAI only: a request to any other host is refused.
 *   - The worst case of every call is counted BEFORE it is sent: the input at US$ 2/M from
 *     chars / 3, plus the whole 128,000-token search window for a search, a 12,000-token reservation at
 *     US$ 10/M, and US$ 0.010 per allowed tool call. It must fit the group cap ((a) 0.20,
 *     (b) 0.30, (c) 0.50) and the US$ 1.00 total.
 *   - The 12,000-token reservation is sent as `max_output_tokens`.
 *
 * Cells
 *   dry run       | no --run                          | exit 0, plan printed, no fetch, runPaid not called
 *   no OpenAI key | --run without OPENAI_API_KEY      | exit 2
 *   worst case    | 3,000 chars; search with 3 calls  | 0.122; 0.408 (literals)
 *   cap           | group spent + worst > cap / total | refused; within both admitted
 *   transport     | GLM host / at cap / normal        | refused / refused before base is called / reservation sent
 *   cases         | a capture fixture                 | (a) per distinct excerpt with GLM's answer, (b) per reading with pages, (c) unverified only
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkMain,
  BenchmarkCapReached,
  buildPlan,
  CapGuard,
  parseCapture,
  passageCases,
  readingCases,
  refusal,
  searchCases,
  worstCaseUsd,
  type BenchmarkCapture,
} from "./benchmark-plan.js";
import { guardedTransport, type CallTiming } from "./benchmark-openai-run.js";

const CAPTURE: BenchmarkCapture = {
  captured_at: "2026-10-11T12:00:00Z",
  cache_rows: [
    {
      id: "gol",
      make: "Volkswagen",
      year: 2021,
      model: "Gol",
      version: "1.0 FLEX 12V 4P",
      viscosities: ["5W-40"],
      viscosity: "5W-40",
      classification: "VW 502 00",
      fill_liters: "3.300",
      fill_kind: "em_servico",
      fill_condition: "with_filter",
      source_publisher: "vw.com.br",
      source_document: "Manual Gol",
      source_page: "pp. 238, 301",
      source_authority: 1,
      source_url: "https://vw.com.br/gol.pdf",
      source_classification: "manufacturer_manual",
      source_excerpt: "SAE 5W-40 … Quantidade de óleo do motor 3,3 litros",
      grade_sources: {
        grades: [{ publisher: "vw.com.br", document: "Manual Gol", page: "pp. 238, 301", authority: 1, url: null, classification: "manufacturer_manual", excerpt: "SAE 5W-40 … Quantidade de óleo do motor 3,3 litros", grades: ["5W-40"] }],
        liters: { publisher: "vw.com.br", document: "Manual Gol", page: "pp. 238, 301", authority: 1, url: null, classification: "manufacturer_manual", excerpt: "SAE 5W-40 … Quantidade de óleo do motor 3,3 litros" },
      },
    },
  ],
  manual_readings: [
    {
      id: "r1",
      url: "https://vw.com.br/gol.pdf",
      make: "Volkswagen",
      year: 2021,
      model: "Gol",
      version: "1.0 FLEX 12V 4P",
      status: "verified",
      spec: { viscosityGrades: ["5W-40"], fillLiters: 3.3, fillCondition: "with_filter", publisher: "vw.com.br", document: "Manual Gol", sourceClass: "manufacturer_manual" },
      cited_page: "pp. 238, 301",
      excerpt: "…",
      read_by: "glm-5.3-flash",
      document_id: "doc-gol",
    },
    // A second reading of the same document: its pages are not repeated in the capture.
    { id: "r1b", url: "https://vw.com.br/gol.pdf", make: "Volkswagen", year: 2021, model: "Gol", version: "1.6 MSI", status: "stated_nothing", spec: null, cited_page: null, excerpt: null, read_by: "glm-5.3-flash", document_id: "doc-gol" },
    { id: "r2", url: "https://x.com.br/y.pdf", make: "Fiat", year: 2022, model: "Argo", version: "1.0", status: "failed", spec: null, cited_page: null, excerpt: null, read_by: null, document_id: null },
  ],
  manual_documents: {
    "doc-gol": [
      { page: 238, text: "Óleo do motor\nUse óleo SAE 5W-40 VW 502 00" },
      { page: 301, text: "Capacidades\nQuantidade de óleo do motor 3,3 litros" },
    ],
  },
  runs: [],
  identities: [
    { identity_key: "2021|VOLKSWAGEN|GOL|1.0", make: "Volkswagen", year: 2021, model: "Gol", version: "1.0", state: "verified", outcome: "verified" },
    { identity_key: "2022|HYUNDAI|HB20|1.0", make: "Hyundai", year: 2022, model: "HB20", version: "1.0 12V Flex", state: "no_spec", outcome: "no_spec" },
    { identity_key: "2021|CHEVROLET|ONIX|1.0", make: "Chevrolet", year: 2021, model: "Onix", version: "1.0 Flex", state: "failed", outcome: "failed" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the entry", () => {
  it("makes no call and does not reach the paid run without --run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runPaid = vi.fn(async () => undefined);
    const lines: string[] = [];
    const code = await benchmarkMain(["--capture", "capture.json"], { env: {}, readFile: () => JSON.stringify(CAPTURE), log: (line) => lines.push(line), runPaid });
    expect(code).toBe(0);
    expect(runPaid).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("dry run — no call made");
    expect(lines.join("\n")).toContain("OpenAI only");
  });

  it("refuses --run without OPENAI_API_KEY, and needs a capture", () => {
    expect(refusal({ run: true, capture: "c.json", report: null, searchIdentities: [] }, {})).toMatch(/OPENAI_API_KEY/);
    expect(refusal({ run: false, capture: null, report: null, searchIdentities: [] }, {})).toMatch(/--capture/);
    expect(refusal({ run: false, capture: "c.json", report: null, searchIdentities: [] }, {})).toBeNull();
  });

  it("reaches the paid run only with --run and the key", async () => {
    const runPaid = vi.fn(async () => undefined);
    await benchmarkMain(["--capture", "c.json", "--run"], { env: { OPENAI_API_KEY: "y" }, readFile: () => JSON.stringify(CAPTURE), log: () => undefined, runPaid });
    expect(runPaid).toHaveBeenCalledTimes(1);
  });
});

describe("the worst case and the caps", () => {
  it("counts the input at chars / 3, the reservation and, for a search, its content and fees", () => {
    // 1,000 tokens × 2 + 12,000 × 10, per million.
    expect(worstCaseUsd(3_000, null)).toBeCloseTo(0.122, 10);
    // (1,000 + 128,000) × 2 + 12,000 × 10, per million, plus 3 × 0.010.
    expect(worstCaseUsd(3_000, { maxToolCalls: 3 })).toBeCloseTo(0.408, 10);
  });

  it("refuses a call that would pass its group cap, and one that would pass the total", () => {
    const guard = new CapGuard();
    guard.set("a", 0.1);
    expect(() => guard.admit("a", 0.122)).toThrow(BenchmarkCapReached);
    expect(() => guard.admit("a", 0.09)).not.toThrow();
    guard.set("a", 0.2);
    guard.set("b", 0.3);
    guard.set("c", 0.3);
    // Group (c) and the total both have 0.20 left: 0.212 passes both.
    expect(() => guard.admit("c", 0.212)).toThrow(BenchmarkCapReached);
  });

  it("enforces the total on its own", () => {
    const guard = new CapGuard(0.25);
    guard.set("a", 0.1);
    guard.set("b", 0.1);
    expect(() => guard.admit("c", 0.06)).toThrow(/total cap/);
  });
});

describe("the guarded transport", () => {
  const deps = (overrides: Partial<Parameters<typeof guardedTransport>[2]> = {}) => ({
    guard: new CapGuard(),
    spentIn: () => 0,
    base: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    timings: [] as CallTiming[],
    onCap: vi.fn(),
    ...overrides,
  });

  it("refuses a model request to GLM's host", async () => {
    const d = deps();
    await expect(guardedTransport("a", "extraction", d)("https://open.bigmodel.cn/api/paas/v4/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/OpenAI only/);
    expect(d.base).not.toHaveBeenCalled();
  });

  it("refuses a call over the cap before it is sent", async () => {
    const d = deps({ spentIn: () => 0.15 });
    await expect(guardedTransport("a", "extraction", d)("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ input: "x".repeat(3_000) }) })).rejects.toBeInstanceOf(BenchmarkCapReached);
    expect(d.base).not.toHaveBeenCalled();
    expect(d.onCap).toHaveBeenCalledWith("a", expect.stringContaining("group (a) cap"));
  });

  it("sends the 12,000-token reservation and times the call", async () => {
    const d = deps();
    await (await guardedTransport("b", "passage", d)("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol" }) })).text();
    const sent = JSON.parse(String((vi.mocked(d.base).mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "gpt-6.1-sol", max_output_tokens: 12_000 });
    expect(d.timings).toEqual([expect.objectContaining({ group: "b", kind: "passage", status: 200 })]);
  });
});

describe("the cases and the plan", () => {
  it("builds a passage case per distinct excerpt, with GLM's stored grades and liters", () => {
    const cases = passageCases(CAPTURE.cache_rows);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.expected).toEqual({ grades: ["5W-40"], liters: 3.3, fillCondition: "with_filter" });
  });

  it("builds a reading case only for a reading with pages, locating its oil pages offline", () => {
    const cases = readingCases(CAPTURE.manual_readings, CAPTURE.manual_documents);
    expect(cases.map((c) => c.id)).toEqual(["r1", "r1b"]);
    expect(cases[0]!.locatedChars).toBeGreaterThan(0);
    expect(cases[0]!.expected).toMatchObject({ status: "verified", grades: ["5W-40"], liters: 3.3 });
    // Two readings of one document read the same pages, which the capture holds once.
    expect(cases[1]!.pages).toEqual(cases[0]!.pages);
    expect(cases[1]!.pages).toHaveLength(2);
  });

  it("rejects a capture without its documents' pages", () => {
    const rest: Partial<BenchmarkCapture> = { ...CAPTURE };
    delete rest.manual_documents;
    expect(() => parseCapture(JSON.stringify(rest))).toThrow(/manual_documents/);
  });

  it("searches only identities with no verified answer", () => {
    expect(searchCases(CAPTURE.identities).map((c) => c.id)).toEqual(["2022|HYUNDAI|HB20|1.0", "2021|CHEVROLET|ONIX|1.0"]);
  });

  it("plans under the US$ 1.00 total, B0 first", () => {
    const { plan } = buildPlan(parseCapture(JSON.stringify(CAPTURE)));
    expect(plan.groups.map((g) => [g.id, g.cases])).toEqual([["a", 1], ["b", 2], ["c", 2]]);
    expect(plan.expectedTotalUsd.high).toBeLessThanOrEqual(1);
    expect(plan.firstCall).toMatch(/^B0/);
  });

  it("rejects a file that is not a capture", () => {
    expect(() => parseCapture('{"cache_rows": []}')).toThrow(/manual_readings/);
  });
});
