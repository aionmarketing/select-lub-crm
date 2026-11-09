/**
 * The paid benchmark run (switch-oil-research-to-openai task 3.4; design.md D9). Imported by
 * `benchmark-openai.ts` only with `--run`, after its guards. Ran once, by the orchestrator, on 2026-10-12.
 *
 * Every model request goes through {@link guardedTransport}:
 * - it refuses any host but OpenAI's, so no other provider can be reached even by a bug;
 * - it refuses a call whose worst case does not fit its group's cap or the US$ 1.00 total
 *   ({@link CapGuard}), counted BEFORE the call is sent;
 * - it sends the 12,000-token output reservation as `max_output_tokens` (benchmark only; a call
 *   cut at it is a recorded failure, B10);
 * - it times each call and the longest gap between body chunks (B4, B6).
 *
 * Pages the searches admit are fetched by the system's own page fetcher, as in production.
 */
import { normalizeSaeGrades, type RetrievedSource } from "../pipeline/oil-spec.js";
import { createModelPassageSelector, type PassageSelector } from "../pipeline/passage-selector.js";
import { createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { readForIdentity } from "../manuals/read-for-identity.js";
import { pagesToSelector } from "../manuals/locate-pages.js";
import { createUsageMeter, type UsageMeter } from "../model-calls/meter.js";
import { researchModelLogLine, type ModelTarget } from "../model-calls/research-model.js";
import { reportUnmeasuredOpenAILimits } from "../model-calls/limits.js";
import { createModelDocumentLinkSelector } from "../retrieval/document-links.js";
import { createOpenAISearch } from "../retrieval/openai-search.js";
import { usageOfResponses } from "../retrieval/openai-responses.js";
import { unanchoredValues } from "../retrieval/stored-manuals.js";
import { createWebSearchRetriever, type WebSearchLog } from "../retrieval/web-search.js";
import type { SourceClassification } from "../../../../shared/web/source-classification.js";
import type { VehicleIdentity } from "../store/store.js";
import {
  BENCHMARK_OUTPUT_RESERVATION_TOKENS,
  BenchmarkCapReached,
  capsOfPlan,
  CapGuard,
  worstCaseUsd,
  type BenchmarkArgs,
  type BenchmarkCase,
  type BenchmarkPlan,
  type GroupId,
} from "./benchmark-plan.js";

/** The only host a model request may go to. */
export const OPENAI_HOST = "https://api.openai.com/";

/** One timed call. */
export type CallTiming = { group: GroupId; kind: string; ms: number; maxGapMs: number; status: number };

/** What the run records. */
export type BenchmarkReport = {
  startedAt: string;
  model: string;
  effort: string;
  plan: BenchmarkPlan;
  b0: { ok: boolean; detail: string };
  cases: Array<Record<string, unknown>>;
  timings: CallTiming[];
  searchLogs: Array<{ log: WebSearchLog }>;
  stopped: Partial<Record<GroupId, string>>;
  spentUsd: { a: number; b: number; c: number; total: number };
  meter: ReturnType<UsageMeter["snapshot"]>;
};

/**
 * A transport for one group and call kind: OpenAI's host only, the cap checked before the call,
 * the output reservation sent, the call timed.
 */
export function guardedTransport(
  group: GroupId,
  kind: string,
  deps: { guard: CapGuard; spentIn: (group: GroupId) => number; base: typeof fetch; timings: CallTiming[]; onCap: (group: GroupId, why: string) => void; now?: () => number },
): typeof fetch {
  const now = deps.now ?? (() => Date.now());
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(OPENAI_HOST)) throw new Error(`benchmark: refused a model request to ${new URL(url).host}: OpenAI only`);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = parseBody(raw);
    const tools = Array.isArray(body.tools) ? (body.tools as Array<{ type?: string }>) : [];
    const search = tools.some((tool) => tool.type === "web_search") ? { maxToolCalls: Number(body.max_tool_calls ?? 1) } : null;
    deps.guard.set(group, deps.spentIn(group));
    try {
      deps.guard.admit(group, worstCaseUsd(raw.length, search));
    } catch (err) {
      if (err instanceof BenchmarkCapReached) deps.onCap(group, err.message);
      throw err;
    }
    const sent = JSON.stringify({ ...body, max_output_tokens: BENCHMARK_OUTPUT_RESERVATION_TOKENS });
    const started = now();
    const res = await deps.base(input, { ...init, body: sent });
    if (!res.body) {
      deps.timings.push({ group, kind, ms: now() - started, maxGapMs: 0, status: res.status });
      return res;
    }
    let last = now();
    let maxGapMs = 0;
    const timed = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const at = now();
          maxGapMs = Math.max(maxGapMs, at - last);
          last = at;
          controller.enqueue(chunk);
        },
        flush() {
          deps.timings.push({ group, kind, ms: now() - started, maxGapMs, status: res.status });
        },
      }),
    );
    return new Response(timed, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** A request body as an object; anything that is not a JSON object reads as empty. */
function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The grades and liters compared with GLM's stored answer. */
function compare(
  expected: { grades: string[]; liters: number | null; fillCondition: string | null },
  got: { grades: string[]; liters: number | null; fillCondition: string | null } | null,
  passage: string | null,
) {
  if (!got) return { agrees: expected.grades.length === 0 && expected.liters === null, got: null, unanchored: [] as string[] };
  const want = new Set(normalizeSaeGrades(expected.grades));
  const have = new Set(normalizeSaeGrades(got.grades));
  const gradesAgree = want.size === have.size && [...want].every((grade) => have.has(grade));
  const litersAgree = expected.liters === null || (got.liters !== null && Math.abs(got.liters - expected.liters) < 0.05);
  const unanchored = unanchoredValues(passage, [...have], got.liters);
  return { agrees: gradesAgree && litersAgree, gradesAgree, litersAgree, fillConditionAgrees: expected.fillCondition === got.fillCondition, got, unanchored };
}

/** Runs the benchmark: B0, then (a), (b), (c), each group stopped by its cap. */
export async function runBenchmark(cases: BenchmarkCase[], plan: BenchmarkPlan, args: BenchmarkArgs, base: typeof fetch = fetch): Promise<BenchmarkReport> {
  const apiKey = process.env.OPENAI_API_KEY!.trim();
  const target: ModelTarget = { provider: "openai", apiKey, model: plan.model, effort: "medium" };
  const meter = createUsageMeter();
  // The caps this run enforces: a group with no cases released its cap to the searches (plan.groups[].capUsd).
  const guard = new CapGuard(plan.totalCapUsd, capsOfPlan(plan));
  const timings: CallTiming[] = [];
  const stopped: Partial<Record<GroupId, string>> = {};
  // Groups run one at a time; the active group's spend is the meter's growth since it was entered.
  let active: GroupId = "c";
  const offset: Record<GroupId, number> = { a: 0, b: 0, c: 0 };
  const spentIn = (group: GroupId) => (group === active ? meter.snapshot().costUsd - offset[group] : guard.group(group));
  const onCap = (group: GroupId, why: string) => {
    stopped[group] ??= why;
  };
  const transport = (group: GroupId, kind: string) => guardedTransport(group, kind, { guard, spentIn, base, timings, onCap });
  const report: BenchmarkReport = {
    startedAt: new Date().toISOString(),
    model: plan.model,
    effort: "medium",
    plan,
    b0: { ok: false, detail: "not run" },
    cases: [],
    timings,
    searchLogs: [],
    stopped,
    spentUsd: { a: 0, b: 0, c: 0, total: 0 },
    meter: meter.snapshot(),
  };
  console.info("benchmark: research model", researchModelLogLine());
  reportUnmeasuredOpenAILimits([{ setting: "benchmark", model: plan.model, effort: "medium" }]);

  /** Enters a group: what it spent before (B0, for the searches) carries over. */
  const begin = (group: GroupId) => {
    active = group;
    offset[group] = meter.snapshot().costUsd - guard.group(group);
  };
  /** Leaves a group, fixing its spend for the total. */
  const finish = (group: GroupId) => {
    guard.set(group, meter.snapshot().costUsd - offset[group]);
    report.spentUsd[group] = guard.group(group);
  };

  // B0: the web_search tool on gpt-6.1-sol, before anything else is spent.
  const searches = cases.filter((entry) => entry.group === "c");
  begin("c");
  if (searches.length > 0) {
    try {
      const res = await transport("c", "b0")(`${OPENAI_HOST}v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: plan.model,
          store: false,
          reasoning: { effort: "medium" },
          tools: [{ type: "web_search", user_location: { type: "approximate", country: "BR" } }],
          tool_choice: "required",
          max_tool_calls: 1,
          include: ["web_search_call.action.sources"],
          input: "Pesquise: Volkswagen Gol 2021 manual do proprietário",
        }),
      });
      const body = (await res.json()) as { output?: Array<{ type?: string }>; usage?: unknown; error?: { message?: string } };
      const calls = (body.output ?? []).filter((item) => item.type === "web_search_call").length;
      meter.onCall({ model: plan.model, provider: "openai", usage: usageOfResponses(body.usage), timedOut: false, accepted: res.ok, effort: "medium" });
      for (let i = 0; i < calls; i += 1) meter.onToolCall({ answered: true, kind: "search" });
      report.b0 = res.ok && calls > 0 ? { ok: true, detail: `${calls} web_search_call item(s)` } : { ok: false, detail: `HTTP ${res.status}: ${body.error?.message ?? "no web_search_call"}` };
    } catch (err) {
      report.b0 = { ok: false, detail: String(err).slice(0, 300) };
    }
    if (!report.b0.ok) {
      finish("c");
      report.meter = meter.snapshot();
      report.spentUsd.total = meter.snapshot().costUsd;
      console.error("benchmark: B0 failed, nothing else is run:", report.b0.detail);
      return report;
    }
  }
  finish("c");

  /** The read ports of one group. */
  const ports = (group: GroupId) => ({
    selectPassage: createModelPassageSelector({ target, meter, transport: transport(group, "passage") }) as PassageSelector,
    rawExtract: createModelOilSpecExtractor({ target, meter, transport: transport(group, "extraction") }),
  });

  // (a) Stored passages.
  begin("a");
  const a = ports("a");
  for (const entry of cases) {
    if (entry.group !== "a" || stopped.a) continue;
    const source: RetrievedSource = {
      publisher: entry.source.publisher,
      document: entry.source.document,
      page: entry.source.page,
      ...(entry.source.authority ? { authority: entry.source.authority as 1 | 2 | 3 | 4 | 5 } : {}),
      ...(entry.source.url ? { url: entry.source.url } : {}),
      ...(entry.source.classification ? { classification: entry.source.classification as SourceClassification } : {}),
      content: { kind: "text", text: entry.source.excerpt ?? "" },
    };
    const selection = await a.selectPassage(source, entry.identity);
    const read = selection.status === "none" ? null : selection.status === "selected" ? selection.source : (selection.fallback ?? source);
    const extracted = read ? await a.rawExtract(read, entry.identity) : null;
    const spec = extracted && "viscosityGrades" in extracted ? { grades: extracted.viscosityGrades, liters: extracted.fillLiters, fillCondition: extracted.fillCondition ?? null } : null;
    const passage = read && read.content.kind === "text" ? read.content.text : null;
    report.cases.push({ group: "a", id: entry.id, identity: entry.identity, expected: entry.expected, failed: extracted !== null && !("viscosityGrades" in extracted), ...compare(entry.expected, spec, passage) });
  }
  finish("a");

  // (b) Manual readings, from their stored pages.
  begin("b");
  const b = ports("b");
  for (const entry of cases) {
    if (entry.group !== "b" || stopped.b) continue;
    const outcome = await readForIdentity(
      { url: entry.url, pages: entry.pages, identity: entry.identity, meta: { ...entry.meta, sourceClass: entry.meta.sourceClass as SourceClassification }, k: pagesToSelector() },
      { selectPassage: b.selectPassage, extract: b.rawExtract },
    );
    const spec = outcome.status === "failed" || !outcome.spec ? null : { grades: outcome.spec.viscosityGrades, liters: outcome.spec.fillLiters, fillCondition: outcome.spec.fillCondition ?? null };
    report.cases.push({
      group: "b",
      id: entry.id,
      identity: entry.identity,
      expected: entry.expected,
      status: outcome.status,
      statusAgrees: outcome.status === entry.expected.status,
      ...compare(entry.expected, spec, outcome.status === "failed" ? null : outcome.excerpt),
    });
  }
  finish("b");

  // (c) OpenAI searches, B0 already counted in the group.
  begin("c");
  const c = ports("c");
  for (const entry of searches) {
    if (stopped.c) break;
    const logs: WebSearchLog[] = [];
    const retrieve = createWebSearchRetriever({
      search: createOpenAISearch({ apiKey, model: plan.model, effort: "medium", meter, httpFetch: transport("c", "search") }),
      selectLinks: createModelDocumentLinkSelector({ target, meter, transport: transport("c", "links") }),
      meter,
      log: (log) => logs.push(log),
    });
    const result = await retrieve(entry.identity as VehicleIdentity);
    const extracted: Array<Record<string, unknown>> = [];
    if (result.status === "found") {
      for (const source of result.sources) {
        if (stopped.c) break;
        const selection = await c.selectPassage(source, entry.identity);
        const read = selection.status === "none" ? null : selection.status === "selected" ? selection.source : (selection.fallback ?? source);
        const spec = read ? await c.rawExtract(read, entry.identity) : null;
        extracted.push({ url: source.url, tier: source.authority, spec, unanchored: spec && "viscosityGrades" in spec && read?.content.kind === "text" ? unanchoredValues(read.content.text, normalizeSaeGrades(spec.viscosityGrades), spec.fillLiters) : [] });
      }
    }
    report.searchLogs.push(...logs.map((log) => ({ log })));
    report.cases.push({ group: "c", id: entry.id, identity: entry.identity, storedOutcome: entry.storedOutcome, status: result.status, manualCandidates: "manualCandidates" in result ? (result.manualCandidates ?? []).length : 0, extracted });
  }
  finish("c");

  report.meter = meter.snapshot();
  report.spentUsd.total = meter.snapshot().costUsd;
  if (args.report) console.info(`benchmark: report written to ${args.report}`);
  return report;
}
