/**
 * Test design (testing-strategy) — the reasoning effort on every research request body (task 1.2, D1)
 *
 * SUT: `openaiEffortFor` / `configuredOpenAIEffort` as every call site uses them — the extractor,
 *   the passage selector, the link selector, escalation, and the web search's search call and
 *   classification — each driven through its production factory over a fake transport that records
 *   the body handed to it. No socket, no key.
 *
 * Oracle: design.md D1/D2 and the `research-model-calls` requirement "Every research call carries
 *   the configured reasoning effort": the body carries `reasoning.effort`; default `medium` for
 *   `gpt-6.1-sol`; one override reaches every call site; checked per request against the model the
 *   request names; a value the model does not accept (`minimal`) sends its default and is reported
 *   once; a model with no entry gets no effort field, is reported once, and is recorded `none`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelPassageSelector } from "../pipeline/passage-selector.js";
import { createEscalationExtractor, createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { createModelDocumentLinkSelector } from "../retrieval/document-links.js";
import { createOpenAISearch } from "../retrieval/openai-search.js";
import { openaiEffortFor, OPENAI_DEFAULT_REASONING_EFFORT, resetEffortReportsForTests } from "./effort.js";
import { answerScript, fakeTransport, responsesStream, searchScript, type CapturedRequest } from "./fake-openai.js";
import { createUsageMeter } from "./meter.js";

const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0" };
const text = (body: string) => ({ publisher: "vw.com.br", document: "Manual", page: "p. 1", content: { kind: "text" as const, text: body } });
const LONG = Array.from({ length: 120 }, (_unused, i) => `Óleo do motor SAE 5W-40, linha ${i + 1} da tabela de capacidades.`).join("\n");
const VERDICTS = '{"verdicts":[{"index":1,"classification":"manufacturer_manual","reason":"m"}]}';

/** Answers every request: the search tool with a source, the classification with a verdict, everything else with a reply. */
function transport() {
  return fakeTransport((request) => {
    if (Array.isArray(request.body.tools)) {
      return responsesStream(searchScript([{ type: "search", sources: ["https://www.vw.com.br/gol/manual"] }]));
    }
    const classifying = JSON.stringify(request.body).includes("resultados de busca");
    return responsesStream(answerScript(classifying ? VERDICTS : '{"none": true}'));
  });
}

/** Runs every call site once. Returns each site's bodies, and the meter of the search. */
async function everyCallSite(): Promise<{ sites: Record<string, CapturedRequest["body"][]>; meter: ReturnType<typeof createUsageMeter> }> {
  const sites: Record<string, CapturedRequest["body"][]> = {};
  const meter = createUsageMeter();
  const run = async (name: string, call: (fetch: typeof globalThis.fetch) => Promise<unknown>) => {
    const fake = transport();
    await call(fake.fetch);
    sites[name] = fake.requests.map((request) => request.body);
  };
  await run("extractor", (fetch) => createModelOilSpecExtractor({ transport: fetch })(text("Óleo SAE 5W-40"), identity));
  await run("passage selector", (fetch) => createModelPassageSelector({ transport: fetch })(text(LONG), identity));
  await run("link selector", (fetch) =>
    createModelDocumentLinkSelector({ transport: fetch })([{ url: "https://vw.com.br/m.pdf", label: "Manual" }], identity, 1, { timeoutMs: 60_000 }),
  );
  await run("escalation", (fetch) => createEscalationExtractor({ transport: fetch })({ identity, conflicts: [], sources: [text("SAE 5W-40")] }));
  await run("web search", (fetch) =>
    createOpenAISearch({ apiKey: "test-key-not-real", effort: openaiEffortFor("gpt-6.1-sol"), httpFetch: fetch, meter, log: () => undefined })("gpt-6.1-sol", "Gol", 120_000),
  );
  return { sites, meter };
}

const ENV = ["OPENAI_API_KEY", "OIL_RESEARCH_REASONING_EFFORT", "OIL_RESEARCH_MODEL", "ESCALATION_MODEL", "ESCALATION_EFFORT"];

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key-not-real";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  resetEffortReportsForTests();
  vi.restoreAllMocks();
});

const warned = () => vi.mocked(console.warn).mock.calls.filter(([message]) => message === "openai-effort");

describe("the effort on the request body", () => {
  it("is medium at every call site with no override", async () => {
    const { sites } = await everyCallSite();

    expect(OPENAI_DEFAULT_REASONING_EFFORT).toBe("medium");
    for (const [name, bodies] of Object.entries(sites)) {
      expect(bodies.length, name).toBeGreaterThan(0);
      for (const body of bodies) expect(body, name).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" } });
    }
  });

  it("reaches every call site from the one setting", async () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "low";
    const { sites } = await everyCallSite();

    for (const [name, bodies] of Object.entries(sites)) {
      for (const body of bodies) expect(body, name).toMatchObject({ reasoning: { effort: "low" } });
    }
  });

  it("falls back to the model's default for a value it does not accept, and reports it once", async () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "minimal";
    const { sites } = await everyCallSite();

    for (const [name, bodies] of Object.entries(sites)) {
      for (const body of bodies) expect(body, name).toMatchObject({ reasoning: { effort: "medium" } });
    }
    const reports = warned().filter(([, detail]) => String(detail).includes("not_accepted"));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]))).toMatchObject({ model: "gpt-6.1-sol", value: "minimal", sent: "medium" });
  });

  it("checks each request against the model it names: escalation may take another effort", async () => {
    process.env.ESCALATION_EFFORT = "xhigh";
    const { sites } = await everyCallSite();

    expect(sites.escalation![0]).toMatchObject({ reasoning: { effort: "xhigh" } });
    expect(sites.extractor![0]).toMatchObject({ reasoning: { effort: "medium" } });
  });

  it("sends no effort to a model with no entry, reports it once, and records none", async () => {
    process.env.OIL_RESEARCH_MODEL = "gpt-9-unlisted";
    const { sites } = await everyCallSite();

    expect(sites.extractor![0]).toMatchObject({ model: "gpt-9-unlisted" });
    expect((sites.extractor![0] as { reasoning?: { effort?: string } }).reasoning?.effort).toBeUndefined();
    expect(warned().filter(([, detail]) => String(detail).includes("no_entry")).length).toBeGreaterThan(0);
    const efforts = (await everyCallSite()).meter.snapshot().efforts;
    expect(efforts.some((entry) => entry.effort === "none" || entry.effort === "medium")).toBe(true);
  });

  it("records the effort sent with the model on the run", async () => {
    const { meter } = await everyCallSite();

    expect(meter.snapshot().efforts).toEqual([{ model: "gpt-6.1-sol", effort: "medium" }]);
  });
});
